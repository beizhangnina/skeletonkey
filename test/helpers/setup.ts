/**
 * The plaintext `file` backend is refused unless this is set. The suite and
 * scripts/demo.sh are the only things allowed to use it.
 */
process.env.SKELETONKEY_ALLOW_TEST_BACKEND = "1";
