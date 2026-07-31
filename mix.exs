defmodule Myelin.MixProject do
  use Mix.Project

  @version "0.2.0"
  @source_url "https://github.com/chromasurf/myelin"

  def project do
    [
      app: :myelin,
      version: @version,
      elixir: "~> 1.15",
      # The native part is a WPE WebKit web process extension, not a NIF. It is
      # cross-compiled against the Nerves system staging dir and loaded by Cog
      # via --web-extensions-dir. On MIX_TARGET=host the Makefile no-ops.
      compilers: [:elixir_make] ++ Mix.compilers(),
      make_targets: ["all"],
      make_clean: ["clean"],
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps(),
      description: description(),
      package: package(),
      docs: docs(),
      source_url: @source_url
    ]
  end

  def application do
    # No process and no supervision tree — but browser_args/0 and browser_env/1 warn
    # through Logger, so it is a real dependency rather than an assumption that
    # every consumer happens to have it started.
    [extra_applications: [:logger]]
  end

  # The harness serves this repository over HTTP so the scripts can be tried in a
  # browser. It only works inside a checkout, so it stays out of :prod rather than
  # compiling into a consumer's release and offering them a `mix` task that can
  # only fail.
  defp elixirc_paths(:dev), do: ["lib", "dev"]
  defp elixirc_paths(:test), do: ["lib", "dev"]
  defp elixirc_paths(_env), do: ["lib"]

  defp deps do
    [
      {:elixir_make, "~> 0.8", runtime: false},
      {:ex_doc, "~> 0.34", only: :dev, runtime: false}
    ]
  end

  defp description do
    "Kiosk UI layer for Nerves: a WPE WebKit web process extension that injects " <>
      "JS and CSS into every session of the Cog browser"
  end

  # `files` is spelled out because the default list would break this package in both
  # directions: it omits Makefile and c_src, so elixir_make would have nothing to
  # build, while including all of priv — where a locally built .so for the wrong
  # architecture would be waiting for available?/0 to find it. So priv/scripts is
  # named on its own, and ideas/ stays out: it is there to be read, not shipped.
  defp package do
    [
      licenses: ["MIT"],
      maintainers: ["Thomas Winkler"],
      links: %{
        "GitHub" => @source_url,
        "Changelog" => "#{@source_url}/blob/main/CHANGELOG.md",
        "Cog" => "https://github.com/Igalia/cog"
      },
      files: [
        "lib",
        "c_src",
        "priv/scripts",
        "Makefile",
        "mix.exs",
        ".formatter.exs",
        "README.md",
        "CHANGELOG.md",
        "CONTRIBUTING.md",
        "LICENSE"
      ]
    ]
  end

  defp docs do
    [
      main: "readme",
      extras: ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE"],
      source_ref: "v#{@version}",
      source_url: @source_url,
      groups_for_modules: [
        "Mix tasks": [Mix.Tasks.Myelin.Copy, Mix.Tasks.Myelin.Harness]
      ]
    ]
  end
end
