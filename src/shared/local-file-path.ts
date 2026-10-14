/** Local reads are user-triggered, not browser file:// navigation. */
export const MAX_LOCAL_FILE_PATH_CHARACTERS = 4096;

export function localFilePath(value: string): string | undefined {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return undefined;
  }
  let path = value.trim();
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (
        url.protocol !== "file:"
        || (url.hostname !== "" && url.hostname !== "localhost")
        || url.search || url.hash
      ) return undefined;
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return undefined;
    }
  }
  if (
    !path || path.length > MAX_LOCAL_FILE_PATH_CHARACTERS
    || /[\x00-\x1f\x7f]/.test(path)
  ) return undefined;
  const portable = path.replace(/\\/g, "/");
  // No network shares, device paths, URI schemes, drive-relative paths or ADS.
  if (portable.startsWith("//")) return undefined;
  const withoutDrive = portable.replace(/^[a-z]:\//i, "");
  if (withoutDrive.includes(":")) return undefined;
  return path;
}
