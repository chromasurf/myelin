# Lowercase on purpose: inets' mod_esi puts the module name in the URL, and
# "Elixir.Mix.Tasks.Harness" in every script tag would be noise. This is the only
# reason not to name it Myelin.Harness.
defmodule :myelin_harness do
  @moduledoc """
  The wrapping half of `mix myelin.harness`.

  On a device the extension wraps each script before evaluating it — the
  script never sees its own file, it sees a function it is the body of. A harness
  that served the files plainly would be testing something else, and the two
  properties that matter would be unobservable: that a script only ever
  gets its own settings, and that a page it does not trust cannot switch it off.

  So the wrapping happens here, in the server, which is where it happens on a
  device too — outside the page. The prelude is read from `c_src/prelude.js`,
  the same file the Makefile compiles into the extension, so there is one copy of
  it and not two that drift.

  Both endpoints read `test/config.json` and the manifests on every request, so
  editing either and reloading is enough — no restart.
  """

  # What the harness serves: the scripts the library ships, and the ideas, which
  # ship nowhere but are still worth being able to try. Not recursive, so each is
  # one level of script directories — the same shape the C loader walks.
  @dirs ["priv/scripts", "ideas"]

  @doc """
  Every script, as the harness needs to know it: which stylesheets to link, which
  files to load in which order, and whether it is on.

  Built from the manifests in `priv/scripts/` and `ideas/`, so a new script appears
  in the harness without anyone updating a list. `shadow_css` is reported
  separately because those files must *not* be linked into the page — they go to
  the script as text.
  """
  def manifests(session, env, input) do
    params = params(input)
    config = device_config()
    trusted = trusted?(params, env, config)

    body =
      ids()
      |> Enum.map(&describe(&1, config, params, trusted))
      |> then(&%{trusted: trusted, scripts: &1})
      |> :json.encode()
      |> IO.iodata_to_binary()

    deliver(session, "application/json", body)
  end

  @doc """
  One script, wrapped exactly as the extension wraps it.

  A script that is switched off gets an empty body rather than a wrapped one:
  on a device it is not injected at all, and a harness that loaded it anyway
  would hide the difference.
  """
  def js(session, env, input) do
    params = params(input)
    id = params["script"]
    file = params["file"]
    config = device_config()
    trusted = trusted?(params, env, config)
    manifest = manifest(id)

    body =
      cond do
        is_nil(manifest) or not safe?(id) or not safe?(file) ->
          "/* no such script */\n"

        not enabled?(manifest, id, config, params, trusted) ->
          "/* #{id} is switched off — the extension would not inject it at all */\n"

        true ->
          wrap(id, file, manifest, config, trusted)
      end

    deliver(session, "text/javascript", body)
  end

  # --- wrapping ---------------------------------------------------------------

  defp wrap(id, file, manifest, config, trusted) do
    source = File.read!(Path.join([root(), dir(id), id, file]))
    {source, source_map} = take_source_map(source)

    argument =
      Enum.map_join(
        [
          id,
          trusted,
          settings(manifest, id, config),
          shadow_css(id, manifest)
        ],
        ", ",
        &json/1
      )

    # The prologue shares line 1 with the file's first line, as in injector.c, so
    # a line number in a stack trace is the line in the file. "use strict" sits in
    # the wrapper for the same reason it does there.
    "(function (ctx) {\"use strict\";" <>
      source <>
      "\n})(" <>
      prelude() <>
      "(" <>
      argument <>
      "))\n//# sourceURL=myelin:///#{id}/#{file}\n" <>
      if(source_map, do: source_map <> "\n", else: "")
  end

  # A sourceMappingURL has to be the last thing in the source to be found, and
  # the wrapper's tail would otherwise sit after it. Same move as injector.c.
  defp take_source_map(source) do
    case Regex.run(~r/\n[ \t]*(\/\/# sourceMappingURL=\S*)[ \t\r\n]*\z/, source) do
      [matched, directive] -> {String.replace_suffix(source, matched, ""), directive}
      nil -> {source, nil}
    end
  end

  defp prelude, do: File.read!(Path.join([root(), "c_src", "prelude.js"]))

  # --- the decision -----------------------------------------------------------

  # Mirrors myl_script_enabled: manifest default, device override, then the meta
  # tags — and those only on a trusted origin. Two implementations of one rule is
  # a cost; each checking the other is the return.
  defp enabled?(manifest, id, config, params, trusted) do
    base =
      case settings(manifest, id, config) do
        %{"enabled" => value} when is_boolean(value) -> value
        _ -> Map.get(manifest, "enabled", false)
      end

    {enable, disable} =
      if trusted do
        {ids_in(params["enable"]), ids_in(params["disable"])}
      else
        {[], []}
      end

    cond do
      id in disable -> false
      id in enable -> true
      true -> base
    end
  end

  defp ids_in(nil), do: []
  defp ids_in(text), do: String.split(text, [" ", ",", "\t"], trim: true)

  # ?trusted=0/1 overrides, which is the switch the harness needs to show the
  # foreign-page case; otherwise the Host header is compared to trusted_origins,
  # as the extension compares the page's origin.
  defp trusted?(params, env, config) do
    case params["trusted"] do
      "0" -> false
      "1" -> true
      _ -> "http://#{host(env)}" in Map.get(config, "trusted_origins", [])
    end
  end

  defp host(env) do
    case List.keyfind(env, :http_host, 0) do
      {_, value} -> to_string(value)
      _ -> ""
    end
  end

  # --- reading ----------------------------------------------------------------

  defp settings(manifest, id, config) do
    device = config |> Map.get("scripts", %{}) |> Map.get(id, %{})

    manifest |> Map.get("config", %{}) |> Map.merge(device)
  end

  defp shadow_css(id, manifest) do
    manifest
    |> content_scripts()
    |> Enum.flat_map(&Map.get(&1, "shadow_css", []))
    |> Enum.map_join("\n", &File.read!(Path.join([root(), dir(id), id, &1])))
  end

  defp describe(id, config, params, trusted) do
    manifest = manifest(id)
    scripts = content_scripts(manifest)

    %{
      id: id,
      name: Map.get(manifest, "name", id),
      description: Map.get(manifest, "description", ""),
      enabled: enabled?(manifest, id, config, params, trusted),
      # Which directory it came out of. Reported rather than left for the page to
      # guess: an id alone does not say where a file is, and a 404 for a stylesheet
      # is a script that looks broken.
      dir: dir(id),
      css: Enum.flat_map(scripts, &Map.get(&1, "css", [])),
      js: Enum.flat_map(scripts, &Map.get(&1, "js", [])),
      shadow_css: Enum.flat_map(scripts, &Map.get(&1, "shadow_css", []))
    }
  end

  defp content_scripts(manifest), do: Map.get(manifest, "content_scripts", [])

  defp ids do
    @dirs
    |> Enum.flat_map(&Path.wildcard(Path.join([root(), &1, "*", "manifest.json"])))
    |> Enum.map(&Path.basename(Path.dirname(&1)))
    |> Enum.uniq()
    |> Enum.sort()
  end

  # Which directory a script lives in. priv/scripts first, so a shipped script wins
  # an id it shares with an idea — the same way a later entry in
  # MYELIN_PATH replaces an earlier one on the device.
  defp dir(id) do
    Enum.find(@dirs, "ideas", &File.dir?(Path.join([root(), &1, id])))
  end

  defp manifest(id) do
    if safe?(id) do
      case File.read(Path.join([root(), dir(id), id, "manifest.json"])) do
        {:ok, text} -> :json.decode(text)
        _ -> nil
      end
    end
  end

  defp device_config do
    case File.read(Path.join([root(), "test", "config.json"])) do
      {:ok, text} -> :json.decode(text)
      _ -> %{}
    end
  rescue
    # A half-edited config.json is the normal state while someone is typing in
    # it. Falling back to none beats a 500 with no clue in it.
    _ -> %{}
  end

  # The query string reaches the filesystem, so anything that could climb out of a
  # source directory is refused. myl_relative_path_ok is the same guard on the C
  # side.
  defp safe?(nil), do: false

  defp safe?(name) do
    name != "" and not String.starts_with?(name, "/") and
      Enum.all?(String.split(name, "/"), &(&1 not in ["", ".", ".."]))
  end

  # --- plumbing ---------------------------------------------------------------

  defp params(input), do: input |> to_string() |> URI.decode_query()

  defp root, do: Application.get_env(:myelin, :harness_root, File.cwd!())

  defp json(value), do: value |> :json.encode() |> IO.iodata_to_binary()

  defp deliver(session, type, body) do
    :mod_esi.deliver(session, ~c"content-type: " ++ String.to_charlist(type) ++ ~c"\r\n\r\n")
    # As a byte list, not a charlist: the scripts contain umlauts, and codepoints
    # would go out as something else.
    :mod_esi.deliver(session, :erlang.binary_to_list(body))
  end
end
