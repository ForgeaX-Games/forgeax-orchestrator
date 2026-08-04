/** Bun build options whose correctness depends on the host path dialect. */
export function buildPlatformOptions(platform) {
  return {
    sourcemap: platform === 'win32' ? 'none' : 'linked',
    preserveSymlinks: true,
  };
}
