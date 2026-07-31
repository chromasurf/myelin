defmodule Mix.Tasks.Myelin.CopyTest do
  # Not async: the task writes into a directory and reads Mix.shell().
  use ExUnit.Case, async: false

  @moduletag :tmp_dir

  @bundled Path.expand("../../../priv/scripts", __DIR__)

  setup do
    # Mix.shell() is global, so it is swapped for the process-collecting one and put
    # back afterwards — otherwise a failure here silences later tests.
    shell = Mix.shell()
    Mix.shell(Mix.Shell.Process)
    on_exit(fn -> Mix.shell(shell) end)
    :ok
  end

  defp run(args), do: Mix.Tasks.Myelin.Copy.run(args)

  defp output do
    receive do
      {:mix_shell, _kind, [message]} -> message <> "\n" <> output()
    after
      0 -> ""
    end
  end

  defp bundled_ids do
    Path.wildcard(Path.join(@bundled, "*/manifest.json"))
    |> Enum.map(&Path.basename(Path.dirname(&1)))
  end

  describe "--list" do
    test "names every bundled script, and writes nothing", %{tmp_dir: tmp} do
      File.cd!(tmp, fn -> run(["--list"]) end)
      listed = output()

      # Built from the manifests, so a new script appears here without anyone
      # remembering to add it.
      assert bundled_ids() != []
      Enum.each(bundled_ids(), fn id -> assert String.contains?(listed, id) end)

      # Listing is the read-only half. Run from the temporary directory so a stray
      # write would land here rather than in the library's own priv/.
      assert File.ls!(tmp) == []
    end

    test "separates stable from beta", %{tmp_dir: tmp} do
      File.cd!(tmp, fn -> run(["--list"]) end)

      [_, rest] = String.split(output(), "Stable:", parts: 2)
      [stable, beta] = String.split(rest, "Beta", parts: 2)

      assert String.contains?(stable, "keyboard")
      assert String.contains?(stable, "screensaver")
      refute String.contains?(stable, "navbar")
      assert String.contains?(beta, "navbar")
    end

    test "says how to switch one on, since copying does not", %{tmp_dir: tmp} do
      File.cd!(tmp, fn -> run(["--list"]) end)
      listed = output()

      assert String.contains?(listed, "config :myelin")
      assert String.contains?(listed, ~s|"keyboard" => %{enabled: true}|)
    end
  end

  describe "no arguments" do
    test "lists and copies nothing", %{tmp_dir: tmp} do
      File.cd!(tmp, fn -> run([]) end)

      # Copying is not a setup step: a script runs from where it ships, so
      # a bare invocation must not scatter directories about.
      assert File.ls!(tmp) == []
      assert String.contains?(output(), "Stable:")
    end
  end

  describe "copying" do
    test "copies every file of the script", %{tmp_dir: tmp} do
      run(["keyboard", "--into", tmp])

      assert File.exists?(Path.join(tmp, "keyboard/manifest.json"))
      assert File.exists?(Path.join(tmp, "keyboard/keyboard.js"))
      assert File.exists?(Path.join(tmp, "keyboard/keyboard.css"))
      assert String.contains?(output(), "copied keyboard")
    end

    test "creates the target directory when it does not exist", %{tmp_dir: tmp} do
      target = Path.join(tmp, "priv/myelin")

      run(["navbar", "--into", target])

      assert File.exists?(Path.join(target, "navbar/manifest.json"))
    end

    test "several at once", %{tmp_dir: tmp} do
      run(["navbar", "statusbar", "--into", tmp])

      assert File.dir?(Path.join(tmp, "navbar"))
      assert File.dir?(Path.join(tmp, "statusbar"))
    end

    test "leaves an existing copy alone and says so", %{tmp_dir: tmp} do
      run(["navbar", "--into", tmp])
      edited = Path.join(tmp, "navbar/navbar.js")
      File.write!(edited, "/* my edits */")
      output()

      run(["navbar", "--into", tmp])

      # A copied script is the user's code. Overwriting it silently would be data
      # loss, so this needs asking for.
      assert File.read!(edited) == "/* my edits */"
      assert String.contains?(output(), "already exists")
    end

    test "--force overwrites", %{tmp_dir: tmp} do
      run(["navbar", "--into", tmp])
      edited = Path.join(tmp, "navbar/navbar.js")
      File.write!(edited, "/* my edits */")
      output()

      run(["navbar", "--force", "--into", tmp])

      assert File.read!(edited) != "/* my edits */"
      assert String.contains?(output(), "copied navbar")
    end

    test "an unknown name fails with the list of what there is", %{tmp_dir: tmp} do
      assert_raise Mix.Error, ~r/no script called "nope"/, fn ->
        run(["nope", "--into", tmp])
      end
    end

    test "an idea is not copyable, because it does not ship", %{tmp_dir: tmp} do
      # ideas/ is in the repository to be read, not in the package. A task that
      # offered to copy one would be offering something a dependency cannot reach.
      assert_raise Mix.Error, ~r/no script called "konami"/, fn ->
        run(["konami", "--into", tmp])
      end
    end

    test "the reminder covers both halves: the search path and switching it on", %{tmp_dir: tmp} do
      run(["navbar", "--into", tmp])
      printed = output()

      assert String.contains?(printed, "browser_env")
      assert String.contains?(printed, ~s|"navbar" => %{enabled: true}|)
    end

    test "the reminder names app_dir for a relative target", %{tmp_dir: tmp} do
      # Run from elsewhere, or a relative --into would write into the real project.
      File.cd!(tmp, fn -> run(["navbar", "--into", "priv/myelin"]) end)

      printed = output()
      assert String.contains?(printed, ~s|Application.app_dir(|)
      assert String.contains?(printed, "priv/myelin")
    end

    test "and prints an absolute target as it is", %{tmp_dir: tmp} do
      # Wrapping an absolute path in app_dir/2 would be nonsense advice.
      run(["navbar", "--into", tmp])

      printed = output()
      refute String.contains?(printed, "Application.app_dir(")
      assert String.contains?(printed, tmp)
    end
  end
end
