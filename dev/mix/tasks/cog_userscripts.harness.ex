defmodule Mix.Tasks.CogUserscripts.Harness do
  @shortdoc "Serves test/harness.html so the userscripts can be tried in a browser"

  @moduledoc """
  Serves the repository over HTTP so `test/harness.html` can load the scripts in
  `priv/scripts/` and `ideas/` and you can try them without a device.

      mix cog_userscripts.harness
      mix cog_userscripts.harness --port 9000

  Only works inside a checkout of this repository, which is why it is compiled in
  `:dev` and `:test` alone — see `elixirc_paths/1` in `mix.exs`.

  Uses `:inets` from OTP rather than a web framework — this only has to hand out
  static files, and pulling in Bandit or Plug for that would be a dependency the
  library does not otherwise need.

  A plain `file://` open mostly works too, but browsers apply stricter CORS rules
  to local files, so serving them avoids a class of confusing failures.
  """

  use Mix.Task

  @default_port 8899

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [port: :integer])
    port = opts[:port] || @default_port

    root = File.cwd!()

    if not File.exists?(Path.join(root, "test/harness.html")) do
      Mix.raise("run this from the cog_userscripts root — test/harness.html not found")
    end

    {:ok, _} = Application.ensure_all_started(:inets)

    # The ESI handler runs inside inets, so it is told where the repository is
    # rather than assuming the working directory has not moved.
    Application.put_env(:cog_userscripts, :harness_root, root)

    case :inets.start(:httpd, httpd_config(root, port)) do
      {:ok, _pid} ->
        Mix.shell().info("""

        cog_userscripts harness

          http://127.0.0.1:#{port}/test/harness.html

        Settings come from the URL, for example:

          http://127.0.0.1:#{port}/test/harness.html?theme=light&enable=konami&screensaver-idle=5

        Ctrl+C twice to stop.
        """)

        Process.sleep(:infinity)

      {:error, {:listen, :eaddrinuse}} ->
        Mix.raise(
          "port #{port} is already in use — try mix cog_userscripts.harness --port #{port + 1}"
        )

      {:error, reason} ->
        Mix.raise("could not start the harness server: #{inspect(reason)}")
    end
  end

  defp httpd_config(root, port) do
    [
      port: port,
      server_name: ~c"cog_userscripts_harness",
      server_root: String.to_charlist(root),
      document_root: String.to_charlist(root),
      # Loopback only. The harness exposes the whole repository directory, which
      # has no business being reachable from the network.
      bind_address: ~c"127.0.0.1",
      directory_index: [~c"harness.html"],
      # Userscripts are not served as files: :cog_harness wraps each one the way
      # the extension does, so what the browser runs is what a device runs.
      # mod_esi puts the module name in the URL, hence the short lowercase one.
      modules: [:mod_alias, :mod_esi, :mod_get, :mod_head, :mod_log],
      erl_script_alias: {~c"/cog", [:cog_harness]},
      erl_script_timeout: 30,
      # No cache headers are set here: :inets ignores its customize callback for
      # static files, so harness.html appends a cache-busting query itself. That
      # also covers opening the file through any other server.
      mime_types: [
        {~c"html", ~c"text/html"},
        {~c"js", ~c"text/javascript"},
        {~c"css", ~c"text/css"},
        {~c"json", ~c"application/json"},
        {~c"svg", ~c"image/svg+xml"},
        {~c"png", ~c"image/png"},
        {~c"ico", ~c"image/x-icon"}
      ]
    ]
  end
end
