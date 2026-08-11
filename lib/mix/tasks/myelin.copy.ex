defmodule Mix.Tasks.Myelin.Copy do
  @shortdoc "Copies a bundled script into your application so you can change it"

  @moduledoc """
  Copies a script out of the library and into your application.

  You do not need this to *run* a script. Everything the library ships is already on
  the search path, dormant, and one line of configuration switches it on:

      config :myelin, scripts: %{"keyboard" => %{enabled: true}}

  Copy one when you want to **change** it. The copy sits later on the search path
  than the bundled version, so it replaces it:

      mix myelin.copy                          # what there is, and how to switch it on
      mix myelin.copy --list                   # the same list
      mix myelin.copy navbar statusbar         # into priv/myelin
      mix myelin.copy statusbar --into priv/kiosk_scripts
      mix myelin.copy keyboard --force         # overwrite an existing copy

  A copied script is yours: edit it, commit it, and an upgrade will not touch it.
  That is also why an existing directory is left alone unless you pass `--force`.
  """

  use Mix.Task

  @default_target "priv/myelin"

  @impl Mix.Task
  def run(args) do
    {opts, names, _} =
      OptionParser.parse(args, strict: [into: :string, force: :boolean, list: :boolean])

    scripts = available()

    cond do
      scripts == [] -> nothing_found()
      names == [] -> list(scripts)
      true -> copy_all(names, scripts, opts)
    end
  end

  defp copy_all(names, scripts, opts) do
    copied = Enum.filter(names, &copy(&1, scripts, opts))

    if copied != [], do: remind(copied, Keyword.get(opts, :into, @default_target))
  end

  # The width and the example line below both need an entry to work from, and
  # elem(nil, 0) raised here rather than saying what was wrong.
  defp nothing_found do
    Mix.shell().error("""

    No script found in #{Path.relative_to_cwd(source_dir())}.

    That directory ships with the library, so an empty one means an incomplete
    checkout of :myelin — try mix deps.clean myelin && mix deps.get.
    """)
  end

  defp list(scripts) do
    width = scripts |> Enum.map(&String.length(&1.id)) |> Enum.max()

    section("Scripts", scripts, width)

    Mix.shell().info("""

    Nothing runs until you switch it on — one line per script:

    #{config_block(["keyboard"])}\
    To change one, copy it first:

        mix myelin.copy #{List.first(scripts).id}
    """)
  end

  defp section(_title, [], _width), do: :ok

  defp section(title, entries, width) do
    Mix.shell().info("\n#{title}:\n")

    Enum.each(entries, fn entry ->
      Mix.shell().info("  #{String.pad_trailing(entry.id, width)}  #{entry.description}")
    end)
  end

  # Returns whether anything was written, so the caller knows whether the reminder is
  # worth printing.
  defp copy(name, scripts, opts) do
    entry = Enum.find(scripts, &(&1.id == name))
    target = Keyword.get(opts, :into, @default_target)
    to = Path.join(target, name)

    if is_nil(entry) do
      Mix.raise("""
      no script called #{inspect(name)}.

      Available: #{Enum.map_join(scripts, ", ", & &1.id)}
      """)
    end

    if File.exists?(to) and not Keyword.get(opts, :force, false) do
      Mix.shell().error("#{to} already exists — left alone. Pass --force to overwrite your copy.")
      false
    else
      File.mkdir_p!(target)
      File.cp_r!(entry.path, to)
      Mix.shell().info("copied #{name} to #{to}")
      report_size(name, to)
      true
    end
  end

  # A script is free to bring a font, a vendored library, an SVG. That belongs in the
  # output here rather than as a surprise in the firmware image, where a few hundred
  # KB of assets is not nothing.
  defp report_size(name, to) do
    bytes =
      [to, "**", "*"]
      |> Path.join()
      |> Path.wildcard()
      |> Enum.map(&File.stat!(&1).size)
      |> Enum.sum()

    if bytes > 50_000 do
      Mix.shell().info("  #{name} is #{div(bytes, 1024)} KB — it bundles assets")
    end
  end

  defp remind(copied, target) do
    Mix.shell().info("""

    Your copy replaces the bundled script once that directory is on the search path:

        Myelin.browser_env(extra: [#{search_path_entry(target)}])

    And it still has to be switched on:

    #{config_block(copied)}\
    """)
  end

  defp config_block(ids) do
    entries = Enum.map_join(ids, ",\n", &~s|        "#{&1}" => %{enabled: true}|)

    """
        config :myelin,
          scripts: %{
    #{entries}
          }

    """
  end

  # A directory inside the application goes through app_dir/2, so it resolves in the
  # release. An absolute path is already where it is going to be.
  defp search_path_entry(target) do
    app = Mix.Project.config()[:app] || :my_app

    if Path.type(target) == :absolute do
      inspect(target)
    else
      ~s|Application.app_dir(:#{app}, "#{target}")|
    end
  end

  # Read from the manifests rather than a table here, which would be one more thing
  # to forget to update.
  defp available do
    [source_dir(), "*", "manifest.json"]
    |> Path.join()
    |> Path.wildcard()
    |> Enum.map(&entry/1)
    # By id, not by path: sorting the paths puts a two-word id before a one-word one,
    # because "-" sorts under "/".
    |> Enum.sort_by(& &1.id)
  end

  defp entry(path) do
    manifest = read(path)

    %{
      id: Path.basename(Path.dirname(path)),
      path: Path.dirname(path),
      description: Map.get(manifest, "description") || Map.get(manifest, "name") || ""
    }
  end

  defp read(path) do
    :json.decode(File.read!(path))
  rescue
    _ -> %{}
  end

  # The scripts live in priv/ now, so this resolves through the application whether
  # the library is a dependency or the project being worked on.
  defp source_dir, do: Myelin.bundled_dir()
end
