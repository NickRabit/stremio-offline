import type { Settings, TileShape, TileSize } from "./types";

/** The settings that size and shape the tiles. They arrive with the rest of the settings, a
 *  moment after the first frame, so the browser keeps the last ones it saw: the skeletons are
 *  drawn at their final size and nothing moves when the settings land. */
const SHAPE_KEYS = ["catalogTileShape", "libraryTileShape", "favoritesTileShape", "resumeTileShape", "followingTileShape", "homeTileShape", "searchTileShape"] as const;
const TILE_SIZES: readonly TileSize[] = ["compact", "small", "medium", "large"];
const TILE_SHAPES: readonly TileShape[] = ["poster", "wide"];
const STORAGE_KEY = "tile-layout";

export type TileLayout = Pick<Settings, "tileSize" | typeof SHAPE_KEYS[number]>;

export function rememberedLayout(): Partial<TileLayout> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return {};
    const record = stored as Record<string, unknown>;
    const layout: Partial<TileLayout> = {};
    if (TILE_SIZES.includes(record.tileSize as TileSize)) layout.tileSize = record.tileSize as TileSize;
    for (const key of SHAPE_KEYS) if (TILE_SHAPES.includes(record[key] as TileShape)) layout[key] = record[key] as TileShape;
    return layout;
  } catch {
    return {};
  }
}

export function rememberLayout(settings: TileLayout): void {
  const layout: Record<string, string> = { tileSize: settings.tileSize };
  for (const key of SHAPE_KEYS) layout[key] = settings[key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage may be unavailable (private mode); the settings still arrive from the server.
  }
}

/** Changes whenever one of the remembered settings does, for an effect's dependency list. */
export const layoutKey = (settings: TileLayout): string =>
  [settings.tileSize, ...SHAPE_KEYS.map((key) => settings[key])].join("|");
