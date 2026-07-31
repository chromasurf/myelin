#include "tests.h"

int tests_run;
int tests_failed;

int main(void)
{
    test_match_pattern();
    test_manifest();
    test_config();

    printf("%d checks, %d failed\n", tests_run, tests_failed);
    return tests_failed == 0 ? 0 : 1;
}
