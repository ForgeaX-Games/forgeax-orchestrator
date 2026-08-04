export function buildPlatformOptions(platform: NodeJS.Platform): {
  sourcemap: 'none' | 'linked';
  preserveSymlinks: true;
};
