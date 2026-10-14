import { localFilePath, MAX_LOCAL_FILE_PATH_CHARACTERS } from "./local-file-path.js";

/** Local raster previews retain their image-only path contract. */
export const MAX_LOCAL_IMAGE_PATH_CHARACTERS = MAX_LOCAL_FILE_PATH_CHARACTERS;

export function localImagePath(value: string): string | undefined {
  const path = localFilePath(value);
  return path && /\.(?:png|jpe?g|webp|gif)$/i.test(path) ? path : undefined;
}
