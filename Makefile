# Builds the WPE WebKit web process extension that Cog loads via
# --web-extensions-dir. Driven by elixir_make from mix.exs.
#
# Three things about the Nerves build are load-bearing here:
#
#   1. Nerves points pkg-config at the *toolchain* (see nerves.mk:
#      PKG_CONFIG_LIBDIR=$(NERVES_TOOLCHAIN)/usr/lib/pkgconfig), not at the
#      system staging dir where the WPE .pc files live. So the pkg-config
#      environment is overridden explicitly below.
#
#   2. libWPEWebKit-2.0.so is NOT in the system staging dir — only its headers
#      and .pc file are. Therefore: --cflags only, never --libs. The library is
#      present on the target at /usr/lib and that is where it gets resolved.
#
#   3. Consequently the .so links with undefined WebKit and JSC symbols, which
#      is correct and intended: the web process has libWPEWebKit loaded when it
#      dlopen()s this module. Do not add -Wl,--no-undefined.

PREFIX := priv/webext
TARGET := $(PREFIX)/libmyelin.so

SOURCES := c_src/extension.c c_src/injector.c c_src/manifest.c \
           c_src/config.c c_src/match_pattern.c c_src/json.c c_src/log.c

# The JS every script is wrapped around lives in a real .js file, so node --check
# covers it and editors treat it as JavaScript, and is turned into C here. As a
# byte array rather than a string literal: escaping one would break the day
# someone puts a backslash in the JS, and this cannot. Regenerated on every build
# and gitignored, so it can never be stale.
PRELUDE_JS := c_src/prelude.js
PRELUDE_H := c_src/generated/prelude.h

.PHONY: all clean check prelude

# Make takes the first target in the file as the default, and the prelude rule
# below stands before the "all" in the conditional. elixir_make passes "all"
# explicitly, so this only matters for a bare "make" by hand — which then built
# nothing but the prelude and looked like it had succeeded.
.DEFAULT_GOAL := all

# Outside the toolchain check on purpose: turning JS into a byte array needs
# nothing but od and awk, so `make prelude` works on any machine and the rule can
# be tested without a cross build.
prelude: $(PRELUDE_H)

$(PRELUDE_H): $(PRELUDE_JS)
	@mkdir -p $(dir $@)
	@echo "/* Generated from $(PRELUDE_JS). Do not edit. */" > $@
	@echo "static const char kMyelinPrelude[] = {" >> $@
	@od -An -v -tu1 $< | awk '{ for (i = 1; i <= NF; i++) printf "%s,", $$i }' >> $@
	@echo "0 };" >> $@

# Without a cross toolchain there is nothing to build: MIX_TARGET=host, CI and
# plain `mix test` must all still succeed. The extension only ever runs inside
# a WPE web process on the device.
ifeq ($(CROSSCOMPILE),)

all:
	@echo "myelin: no Nerves target (CROSSCOMPILE unset), skipping the native build"

clean:
	rm -rf $(PREFIX) $(dir $(PRELUDE_H))

else

ifeq ($(NERVES_SDK_SYSROOT),)
$(error NERVES_SDK_SYSROOT is not set — cannot locate the WPE WebKit headers)
endif

CC ?= $(CROSSCOMPILE)-gcc

# Nerves points PKG_CONFIG at $(NERVES_TOOLCHAIN)/usr/bin/pkg-config, which not
# every toolchain build actually ships. Fall back to the one on PATH — the
# pkg-config binary is host tooling, what makes the lookup cross-correct is the
# PKG_CONFIG_LIBDIR/SYSROOT_DIR pair below.
ifeq ($(wildcard $(PKG_CONFIG)),)
PKG_CONFIG := pkg-config
endif

# Prefixed inline rather than exported, so the override is in effect for these
# $(shell) calls regardless of make's export ordering.
PKG_CONFIG_ENV := PKG_CONFIG_LIBDIR=$(NERVES_SDK_SYSROOT)/usr/lib/pkgconfig \
                  PKG_CONFIG_SYSROOT_DIR=$(NERVES_SDK_SYSROOT) \
                  PKG_CONFIG_PATH=

# Headers only — see note 2 above.
WPE_CFLAGS := $(shell $(PKG_CONFIG_ENV) $(PKG_CONFIG) --cflags wpe-web-process-extension-2.0)
GLIB_CFLAGS := $(shell $(PKG_CONFIG_ENV) $(PKG_CONFIG) --cflags gio-2.0 gmodule-2.0)
GLIB_LIBS := $(shell $(PKG_CONFIG_ENV) $(PKG_CONFIG) --libs gio-2.0 gmodule-2.0)

ifeq ($(WPE_CFLAGS),)
$(error pkg-config found no wpe-web-process-extension-2.0 in $(NERVES_SDK_SYSROOT)/usr/lib/pkgconfig)
endif

# -fvisibility=hidden keeps our myl_* symbols out of the web process, where
# they would otherwise sit in the same global namespace as WebKit's. Only the
# entry point is exported, via G_MODULE_EXPORT.
BUILD_CFLAGS := $(CFLAGS) -std=gnu99 -Wall -Wextra -fPIC -fvisibility=hidden \
                $(WPE_CFLAGS) $(GLIB_CFLAGS)

all: $(TARGET)

$(TARGET): $(SOURCES) $(PRELUDE_H) $(wildcard c_src/*.h) $(wildcard c_src/vendor/*.h)
	@mkdir -p $(PREFIX)
	$(CC) $(BUILD_CFLAGS) -shared -o $@ $(SOURCES) $(LDFLAGS) $(GLIB_LIBS)

clean:
	rm -rf $(PREFIX) $(dir $(PRELUDE_H))

endif

# Host-side unit tests for the parsing and matching layer. Independent of the
# cross build: no GLib, no WPE, no toolchain.
check:
	$(MAKE) -C test/c check
