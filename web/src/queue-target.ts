import type { LibraryView } from "./types";

/** Segment zero of a download target is a library id, the same as everywhere else. An id
 *  says nothing to anybody, so the library is named and the path below it stands on its own.
 *  A single-library install writes plain paths, and those are shown as they are. */
export function queueDestination(target: string, libraries: LibraryView[]): { library?: string; path: string } {
  const [head, ...rest] = target.split("/");
  const library = libraries.find((item) => item.id === head);
  return library && rest.length ? { library: library.name, path: rest.join("/") } : { path: target };
}
