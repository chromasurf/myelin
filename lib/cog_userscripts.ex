defmodule CogUserscripts do
  @moduledoc """
  Wires the userscript extension into a Cog command line.

  There is no process and no supervision tree here — the whole runtime lives in
  the web process extension that Cog loads. This module answers three questions
  and nothing else: where the `.so` is, which directories it should scan, and
  what the device wants configured.

  ## Usage

  Merge two things into however you already start Cog — `cog_args/0` for the
  command line, `cog_env/1` for the environment:

      args = ["--platform=drm", url] ++ CogUserscripts.cog_args()
      env = [{"XDG_RUNTIME_DIR", runtime_dir}] ++ CogUserscripts.cog_env()

      MuonTrap.Daemon.start_link("cog", args, env: env)

  Scripts are read once, when the web process starts, so changes take effect after
  Cog restarts.

  ## Nothing runs until you ask for it

  The scripts that ship with this library are in `bundled_dir/0`, which is already
  on the search path — but every one of them is dormant. Switching one on is a
  line of configuration, and that is the whole install:

      config :cog_userscripts,
        scripts: %{
          "keyboard" => %{enabled: true},
          "screensaver" => %{enabled: true}
        }

  Copy one into your own application only when you want to change it —
  `mix cog_userscripts.copy keyboard` — and the copy replaces the shipped version,
  because later entries on the search path win.

  ## Configuration

  Two things are set per device, both read from your application's config:

      config :cog_userscripts,
        trusted_origins: ["http://localhost:4000"],
        scripts: %{"screensaver" => %{enabled: true, idle: 300}}

  The keys under `scripts` are directory names.

  `trusted_origins` decides where `<meta name="cog-…">` tags may configure
  anything. It starts empty, so on a page you have not listed the device
  configuration is the only thing that counts — which is the point on a kiosk that
  visits pages you do not control.

  Both travel to the extension in `COG_USERSCRIPTS_CONFIG`. That is not a
  flourish: the extension runs in Cog's web process, not on the BEAM, so it
  cannot call `Application.get_env/2`. A file or the process environment are the
  only two channels, and a file would mean writing one at boot.
  """

  require Logger

  # The device configuration is encoded with :json, which arrived in OTP 27. Mix
  # has no way to express an OTP floor, so it is checked here — on OTP 26 this
  # would otherwise compile fine and fail at runtime with an undefined function,
  # somewhere inside a firmware image.
  if not Code.ensure_loaded?(:json) do
    raise "cog_userscripts needs OTP 27 or newer (for :json), found OTP " <>
            List.to_string(:erlang.system_info(:otp_release))
  end

  @extension_name "libcog_userscripts.so"

  @doc """
  Directory to pass to Cog's `--web-extensions-dir`.

  It holds nothing but the extension, because WebKit loads *every* `.so` it
  finds there.
  """
  @spec extension_dir() :: String.t()
  def extension_dir, do: Path.join(priv_dir(), "webext")

  @doc "Full path of the extension shared object."
  @spec extension_path() :: String.t()
  def extension_path, do: Path.join(extension_dir(), @extension_name)

  @doc """
  Whether the extension was built.

  False on `MIX_TARGET=host`, where the Makefile skips the native build.
  """
  @spec available?() :: boolean()
  def available?, do: File.exists?(extension_path())

  @doc """
  Directory of the scripts that ship with this library.

  It is on the search path already, so switching one on takes configuration and
  nothing else:

      config :cog_userscripts, scripts: %{"keyboard" => %{enabled: true}}
  """
  @spec bundled_dir() :: String.t()
  def bundled_dir, do: Path.join(priv_dir(), "scripts")

  @doc """
  Directories the extension scans, in order. Later entries win.

  `bundled_dir/0` comes first, then anything you configure, then anything you
  pass. So a copy of a shipped script in your own application replaces the
  shipped one, which is what `mix cog_userscripts.copy` is for:

      config :cog_userscripts, extra_dirs: ["/opt/my_app/userscripts"]

      CogUserscripts.script_path(extra: [Application.app_dir(:my_app, "priv/userscripts")])

  To iterate on a device without a firmware build — `scp` a script over, restart
  Cog — add the writable partition:

      config :cog_userscripts, extra_dirs: ["/data/cog-userscripts"]
  """
  @spec script_path(keyword()) :: [String.t()]
  def script_path(opts \\ []) do
    configured = Application.get_env(:cog_userscripts, :extra_dirs, [])

    [bundled_dir()] ++ configured ++ Keyword.get(opts, :extra, [])
  end

  @doc """
  Arguments to append to Cog's command line.

  Returns `[]` when the extension is not built, so a host build does not point
  Cog at a directory that does not exist.
  """
  @spec cog_args() :: [String.t()]
  def cog_args do
    if available?() do
      ["--web-extensions-dir=#{extension_dir()}"]
    else
      Logger.warning(
        "[CogUserscripts] #{extension_path()} is missing — no userscripts will load. " <>
          "Expected on MIX_TARGET=host; on a device it means the native build did not run."
      )

      []
    end
  end

  @doc """
  The device configuration, as it will be encoded.

  Contains only what is actually set, so an application that configures nothing
  gets `%{}`. Useful for seeing what a release will hand over:

      mix run -e 'IO.inspect CogUserscripts.config()'
  """
  @spec config() :: map()
  def config do
    %{}
    |> put_configured(:trusted_origins, [])
    |> put_configured(:scripts, %{})
  end

  @doc """
  Environment to merge into Cog's.

  Takes the same `:extra` option as `script_path/1`:

      CogUserscripts.cog_env(extra: [Application.app_dir(:my_app, "priv/userscripts")])

  Two variables:

  * `COG_USERSCRIPTS_PATH` — the search path from `script_path/1`, colon
    separated. Always set, because the bundled scripts are always on it.
  * `COG_USERSCRIPTS_CONFIG` — `config/0` as JSON, when anything is configured.

  Reading is all this does: no file is written, nothing is created, no process
  starts.

  Also set `{"G_MESSAGES_DEBUG", "cog-userscripts"}` to have the extension log
  which manifests it found and which scripts it injected.

  > #### OTP 27 {: .info}
  >
  > The JSON is encoded with `:json`, which arrived in OTP 27. That keeps this
  > library free of a JSON dependency; the cost is the floor.
  """
  @spec cog_env(keyword()) :: [{String.t(), String.t()}]
  def cog_env(opts \\ []) do
    path = [{"COG_USERSCRIPTS_PATH", Enum.join(script_path(opts), ":")}]

    case config() do
      empty when empty == %{} ->
        path

      config ->
        case encode_json(config) do
          {:ok, json} -> path ++ [{"COG_USERSCRIPTS_CONFIG", json}]
          :error -> path
        end
    end
  end

  defp put_configured(map, key, empty) do
    value = normalize(Application.get_env(:cog_userscripts, key, empty))

    # `[]` is how Elixir spells both "empty list" and "empty keyword list", so for
    # a key whose default is a map it means "nothing configured" too.
    if value == empty or (value == [] and is_map(empty)) do
      map
    else
      Map.put(map, key, value)
    end
  end

  # Elixir has two spellings for "a map of settings" and both look right in a
  # config file:
  #
  #     scripts: %{"keyboard" => %{layout: "en"}}
  #     scripts: [keyboard: %{layout: "en"}]
  #
  # The second is a keyword list, which `:json.encode/1` refuses outright, so it
  # becomes a map here instead of reaching the encoder. Recursively, because the
  # same choice comes up again for the settings of a single script. A list that is
  # not a keyword list — `trusted_origins`, or a script setting that really is a
  # list of strings — stays a list.
  defp normalize(value) when is_list(value) do
    if keyword?(value) do
      Map.new(value, fn {key, nested} -> {key, normalize(nested)} end)
    else
      Enum.map(value, &normalize/1)
    end
  end

  defp normalize(value) when is_map(value) and not is_struct(value) do
    Map.new(value, fn {key, nested} -> {key, normalize(nested)} end)
  end

  defp normalize(value), do: value

  defp keyword?([]), do: false

  defp keyword?(list) do
    Enum.all?(list, fn
      {key, _value} when is_atom(key) -> true
      _other -> false
    end)
  end

  # Called while the caller is still building its supervision tree, which is why
  # this cannot raise: a `config :cog_userscripts` value that `:json` will not
  # take would otherwise propagate out of `init/1`, the supervisor would give up,
  # and the device would boot to a black panel with no browser at all. The
  # extension goes to lengths to keep a malformed configuration from doing that —
  # "a typo in runtime.exs must not take every script down with it" — and crashing
  # before it ever sees the value would make that promise worthless. So the
  # variable is left out and every script keeps its manifest defaults.
  defp encode_json(term) do
    {:ok, term |> :json.encode() |> IO.iodata_to_binary()}
  rescue
    error ->
      encode_failed(Exception.message(error))
  catch
    kind, reason ->
      encode_failed("#{kind} #{inspect(reason)}")
  end

  defp encode_failed(detail) do
    Logger.error(
      "[CogUserscripts] the device configuration cannot be encoded as JSON " <>
        "(#{detail}) — COG_USERSCRIPTS_CONFIG will not be set and every script " <>
        "keeps its manifest defaults. Check `config :cog_userscripts` for a value " <>
        "that is not a map, list, string, number or boolean."
    )

    :error
  end

  defp priv_dir do
    case :code.priv_dir(:cog_userscripts) do
      {:error, :bad_name} ->
        raise "the :cog_userscripts application is not loaded"

      path ->
        List.to_string(path)
    end
  end
end
