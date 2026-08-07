defmodule MyelinTest do
  use ExUnit.Case, async: true

  describe "paths" do
    test "extension_dir sits under priv" do
      assert String.ends_with?(Myelin.extension_dir(), "/priv/webext")
    end

    test "extension_path names the shared object" do
      assert String.ends_with?(Myelin.extension_path(), "libmyelin.so")
    end

    test "priv holds the scripts and the extension, and nothing else" do
      priv = Path.dirname(Myelin.extension_dir())

      # The scripts ship in priv/scripts, which is the only reason they exist on a
      # device at all: Mix copies a dependency's priv/ and ebin/ into the build and
      # nothing else. Anything *other* than these two is what this catches.
      #
      # webext may be absent on MIX_TARGET=host, where the native build is skipped;
      # whether it was built is available?/0's business.
      assert [] == Enum.reject(File.ls!(priv), &(&1 in ["scripts", "webext"]))
    end

    test "bundled_dir points at the scripts that ship" do
      assert File.dir?(Path.join(Myelin.bundled_dir(), "keyboard"))
    end
  end

  describe "search path" do
    test "the bundled scripts are on it without anyone asking" do
      # This is what lets a script run on configuration alone. If it ever returns
      # only the caller's directories again, switching a script on stops working and
      # the failure is a script that silently never loads.
      assert [Myelin.bundled_dir()] == Myelin.script_path()
    end

    test "bundled first, then configured, then passed" do
      Application.put_env(:myelin, :extra_dirs, ["/configured"])
      on_exit(fn -> Application.delete_env(:myelin, :extra_dirs) end)

      # Later entries win in the loader, so this order is what lets a copy in an
      # application replace the script it was copied from.
      assert [Myelin.bundled_dir(), "/configured", "/passed"] ==
               Myelin.script_path(extra: ["/passed"])
    end
  end

  describe "browser integration" do
    test "browser_env carries the search path colon separated" do
      bundled = Myelin.bundled_dir()

      assert [{"MYELIN_PATH", path}] =
               Myelin.browser_env(extra: ["/app/one", "/app/two"])

      assert path == "#{bundled}:/app/one:/app/two"
    end

    test "the search path is always set, because the bundled scripts are always on it" do
      assert [{"MYELIN_PATH", path}] = Myelin.browser_env()
      assert path == Myelin.bundled_dir()
    end

    test "browser_args reflects whether the extension was built" do
      # On the host the native build is skipped, so this exercises the absent
      # branch; on a device build it exercises the present one.
      if Myelin.available?() do
        assert ["--web-extensions-dir=" <> dir] = Myelin.browser_args()
        assert dir == Myelin.extension_dir()
      else
        assert Myelin.browser_args() == []
      end
    end
  end

  describe "device configuration" do
    setup do
      on_exit(fn ->
        Application.delete_env(:myelin, :trusted_origins)
        Application.delete_env(:myelin, :scripts)
      end)
    end

    test "nothing configured means no variable at all" do
      assert %{} == Myelin.config()
      refute List.keymember?(Myelin.browser_env(extra: ["/a"]), "MYELIN_CONFIG", 0)
    end

    test "only what is set ends up in the map" do
      Application.put_env(:myelin, :trusted_origins, ["http://localhost:4000"])

      assert %{trusted_origins: ["http://localhost:4000"]} == Myelin.config()
    end

    test "browser_env encodes the configuration as JSON the extension can read back" do
      Application.put_env(:myelin, :trusted_origins, ["http://localhost:4000"])

      Application.put_env(:myelin, :scripts, %{
        "domain-block" => %{allowlist: ["localhost:4000"], home: "http://localhost:4000/"},
        "screensaver" => %{enabled: false, idle: 300}
      })

      assert [{"MYELIN_PATH", _}, {"MYELIN_CONFIG", json}] =
               Myelin.browser_env()

      # Decoded rather than compared as a string: map order is not ours to
      # predict, and what matters is that atom keys arrive as strings — which is
      # what the C side looks for.
      assert %{
               "trusted_origins" => ["http://localhost:4000"],
               "scripts" => %{
                 "domain-block" => %{
                   "allowlist" => ["localhost:4000"],
                   "home" => "http://localhost:4000/"
                 },
                 "screensaver" => %{"enabled" => false, "idle" => 300}
               }
             } == :json.decode(json)
    end

    test "a keyword list is as good a spelling as a map" do
      # [keyboard: %{...}] and %{"keyboard" => %{...}} are the same thing to read
      # and indistinguishable at a glance in a config file, but :json.encode/1
      # refuses a keyword list outright. Since browser_env/1 is called while the caller
      # builds its supervision tree, such a raise would take the Cog daemon down
      # with it and the device would boot to a black panel.
      Application.put_env(:myelin, :scripts, keyboard: %{layout: "en"})

      assert [{"MYELIN_PATH", _}, {"MYELIN_CONFIG", json}] =
               Myelin.browser_env()

      assert %{"scripts" => %{"keyboard" => %{"layout" => "en"}}} == :json.decode(json)
    end

    test "a keyword list inside a script's settings encodes too" do
      Application.put_env(:myelin, :scripts, %{"statusbar" => [items: ["clock"]]})

      assert [{"MYELIN_PATH", _}, {"MYELIN_CONFIG", json}] =
               Myelin.browser_env()

      assert %{"scripts" => %{"statusbar" => %{"items" => ["clock"]}}} == :json.decode(json)
    end

    test "a list that is not a keyword list stays a list" do
      Application.put_env(:myelin, :trusted_origins, ["http://a.test"])

      Application.put_env(:myelin, :scripts, %{"statusbar" => %{items: ["clock", "url"]}})

      assert [{"MYELIN_PATH", _}, {"MYELIN_CONFIG", json}] =
               Myelin.browser_env()

      assert %{
               "trusted_origins" => ["http://a.test"],
               "scripts" => %{"statusbar" => %{"items" => ["clock", "url"]}}
             } == :json.decode(json)
    end

    test "an empty list for scripts means nothing configured, not a value of the wrong shape" do
      Application.put_env(:myelin, :scripts, [])

      assert %{} == Myelin.config()
    end

    test "a value JSON cannot carry is reported, not raised" do
      # The extension degrades a malformed configuration to an empty one on
      # purpose — "a typo in runtime.exs must not take every script down with it".
      # Raising on this side, before the extension ever sees the value, would make
      # that promise worthless.
      Application.put_env(:myelin, :scripts, %{"a" => %{stamp: {2026, 7, 29}}})

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          # The search path still arrives; only the configuration is dropped.
          assert [{"MYELIN_PATH", _}] = Myelin.browser_env(extra: ["/app"])
        end)

      assert log =~ "cannot be encoded as JSON"
    end

    test "reading the configuration writes nothing" do
      Application.put_env(:myelin, :scripts, %{"keyboard" => %{layout: "en"}})

      before = tree()

      Myelin.config()
      Myelin.browser_env(extra: ["/app"])
      Myelin.browser_args()

      # An earlier design for this wrote a config file at boot, which is why the
      # absence of one is asserted rather than assumed: these helpers only read.
      assert before == tree()
    end

    # priv/ is where the extension lives and where a written file would most
    # plausibly land; the project root covers a stray file in the cwd. Both are
    # cheap to walk, unlike the whole checkout.
    defp tree do
      priv = Path.dirname(Myelin.extension_dir())
      root = Path.expand("..", __DIR__)

      paths =
        Path.wildcard(Path.join([priv, "**", "*"]), match_dot: true) ++
          Path.wildcard(Path.join(root, "*"), match_dot: true)

      Enum.sort(paths)
    end
  end

  describe "manifests" do
    # A broken manifest loads nothing and only warns into the Cog log, so it would
    # surface as a script that mysteriously never runs.
    test "every manifest is valid JSON with content_scripts" do
      manifests = manifest_paths()

      assert length(manifests) == 13

      manifests
      |> Enum.each(fn path ->
        contents = File.read!(path)

        # No JSON library as a dependency here — a structural check is enough
        # to catch a truncated or hand-mangled manifest. The C parser is what
        # actually validates them, under test/c.
        assert String.starts_with?(String.trim(contents), "{")
        assert String.contains?(contents, "\"content_scripts\"")
        assert String.contains?(contents, "\"matches\"")

        # Every file a manifest references must exist next to it.
        dir = Path.dirname(path)

        ~r/"(?:js|css)"\s*:\s*\[([^\]]*)\]/
        |> Regex.scan(contents, capture: :all_but_first)
        |> Enum.flat_map(fn [list] ->
          Regex.scan(~r/"([^"]+)"/, list, capture: :all_but_first)
        end)
        |> Enum.each(fn [file] ->
          assert File.exists?(Path.join(dir, file)),
                 "#{path} references #{file}, which does not exist"

          # myl_relative_path_ok() allows a subdirectory — a build writes into one
          # — but nothing that could leave the script's directory. A manifest that
          # breaks that rule loads nothing and only warns into the Cog log, so it
          # is caught here instead.
          refute String.starts_with?(file, "/") or
                   "." in Path.split(file) or
                   ".." in Path.split(file) or
                   String.contains?(file, "//") or
                   String.contains?(file, "\\"),
                 "#{path} references #{file}, which does not stay inside the script " <>
                   "directory; the injector refuses to read it"
        end)
      end)
    end

    test "nothing is enabled by default" do
      # The scripts ship on the search path, so "enabled" is the only thing standing
      # between a copied-in library and thirteen scripts on every page. A manifest
      # that switches itself on is not a detail, which is why it fails here first.
      #
      # Decoded rather than matched as a string, so a reformatted manifest cannot
      # make this pass.
      on =
        manifest_paths()
        |> Enum.filter(&(Map.get(:json.decode(File.read!(&1)), "enabled", false) == true))
        |> Enum.map(&Path.basename(Path.dirname(&1)))

      assert on == []
    end

    test "no manifest carries defaults the script already declares" do
      # A script declares its settings in ctx.script({config: …}). A "config" block
      # in the manifest would be a second place for the same defaults, and the two
      # would drift.
      with_config =
        manifest_paths()
        |> Enum.filter(&Map.has_key?(:json.decode(File.read!(&1)), "config"))
        |> Enum.map(&Path.basename(Path.dirname(&1)))

      assert with_config == []
    end

    test "every script id is unique across both directories" do
      ids = Enum.map(manifest_paths(), &Path.basename(Path.dirname(&1)))

      # A shared id resolves — priv/scripts wins — but to whichever one the reader
      # did not mean.
      assert ids == Enum.uniq(ids)
    end
  end

  describe "the script format" do
    test "a script is a file body, not a construct to learn" do
      # The point of the format is that there is barely one: no wrapper object, no
      # IIFE of its own, and no "use strict" — that lives in the wrapper the loader
      # emits, once, instead of in thirteen files.
      Enum.each(script_sources(), fn {id, source} ->
        refute source =~ "ctx.script(", "#{id} still declares itself through a spec object"
        refute source =~ ~r/^\(function \(\) \{/m, "#{id} still opens an IIFE of its own"
        refute source =~ ~s("use strict"), "#{id} declares use strict; the wrapper does that"
      end)
    end

    test "every script reads its settings through ctx.config" do
      # Which is also what keeps the defaults in one place per setting: next to the
      # read, rather than in a block twenty lines up.
      Enum.each(script_sources(), fn {id, source} ->
        assert source =~ "ctx.config(", "#{id} reads no settings — is that deliberate?"
      end)
    end

    test "no script reaches for something the surface no longer offers" do
      # ctx is config, on, emit and css. The rest either never had a caller or had
      # exactly one, and that one now carries it — keyboard has the focus tracking.
      #
      # Word-anchored, because "itself." and "myself." are prose, not a stray binding.
      gone = [~r/\bself\./, ~r/\bcog\./, ~r/window\.cog =/, ~r/ctx\.(meta|push|mount)\(/]

      Enum.each(script_sources(), fn {id, source} ->
        Enum.each(gone, fn dead ->
          refute source =~ dead, "#{id} still uses #{inspect(dead)}"
        end)
      end)
    end

    test "a script is stable or says it is beta, and the copy task agrees" do
      # Two statements about the same thing — the header a reader sees first, and the
      # list mix myelin.copy groups by. This is what keeps them in step.
      stable =
        bundled_sources()
        |> Enum.reject(fn {_id, source} -> source =~ ~r/^ \* Beta\.$/m end)
        |> Enum.map(fn {id, _source} -> id end)
        |> Enum.sort()

      assert stable == ["keyboard", "screensaver"]
    end
  end

  # Both directories, one level deep — the shape the C loader walks. ideas/ is not
  # shipped, but it is held to the same format.
  defp manifest_paths, do: manifests_in("../priv/scripts") ++ manifests_in("../ideas")

  defp manifests_in(dir) do
    Path.wildcard(Path.join([__DIR__, dir, "*", "manifest.json"]))
  end

  defp bundled_sources, do: sources("../priv/scripts")

  defp script_sources, do: bundled_sources() ++ sources("../ideas")

  defp sources(dir) do
    Enum.map(manifests_in(dir), fn path ->
      id = Path.basename(Path.dirname(path))
      {id, File.read!(Path.join(Path.dirname(path), "#{id}.js"))}
    end)
  end
end
