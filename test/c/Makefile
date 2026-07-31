# Host-side unit tests for the libc-only parsing and matching layer.
# Runs anywhere with a C compiler — no GLib, no WPE WebKit, no Nerves toolchain.
#
#   make -C test/c check

CC ?= cc
# gnu99, not c99: mkdtemp() is POSIX and glibc hides it behind the feature-test
# macros that strict -std=c99 disables. macOS declares it either way, so this
# only shows up on Linux — which is where CI runs.
CFLAGS ?= -std=gnu99 -Wall -Wextra -Werror -g -O0
CORE := ../../c_src

SOURCES := main.c test_match_pattern.c test_manifest.c test_config.c \
           $(CORE)/match_pattern.c $(CORE)/manifest.c $(CORE)/config.c \
           $(CORE)/json.c $(CORE)/log.c

run: $(SOURCES) tests.h $(CORE)/match_pattern.h $(CORE)/manifest.h \
     $(CORE)/config.h $(CORE)/json.h $(CORE)/log.h
	$(CC) $(CFLAGS) -o $@ $(SOURCES)

.PHONY: check clean syntax
check: run
	./run

# injector.c and extension.c are the only files that touch WebKit, so they are
# not part of `check` and nothing compiled them before a device build — a typo
# used to travel into a firmware image. This compiles them against declared
# signatures in stubs/, which needs GLib but no WPE WebKit.
#
# Deliberately hard-fails without GLib rather than skipping: a check that goes
# green while checking nothing is worse than no check.
syntax:
	$(MAKE) -C ../.. prelude
	$(CC) -fsyntax-only -std=gnu99 -Wall -Wextra -Werror \
	      -Istubs -I$(CORE) \
	      $(shell pkg-config --cflags gio-2.0 gmodule-2.0) \
	      $(CORE)/injector.c $(CORE)/extension.c

clean:
	rm -f run
