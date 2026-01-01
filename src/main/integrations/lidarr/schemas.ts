export type LidarrQualityProfile = {
  id: number;
  name: string;
};

export type LidarrMetadataProfile = {
  id: number;
  name: string;
};

export type LidarrRootFolder = {
  id: number;
  path: string;
  freeSpace: number;
};

export type LidarrArtistLookupResult = {
  foreignArtistId: string;
  artistName: string;
  overview: string;
  images: Array<{
    url: string;
    coverType: string;
  }>;
  links: Array<{
    url: string;
    name: string;
  }>;
  genres: string[];
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  monitored?: boolean;
};

export type LidarrAddArtistOptions = {
  monitor: "all" | "future" | "missing" | "existing" | "first" | "latest" | "none";
  searchForMissingAlbums: boolean;
  AlbumsToMonitor?: string[];
};

export type LidarrAddArtistPayload = LidarrArtistLookupResult & {
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  monitored: boolean;
  addOptions: LidarrAddArtistOptions;
};

export type LidarrArtistResponse = {
  id: number;
  artistName: string;
  foreignArtistId: string;
  monitored: boolean;
};

export type LidarrErrorResponse = {
  message?: string;
  propertyName?: string;
  errorMessage?: string;
};

export type AlbumLibraryInfo = {
  album: string;
  artist: string;
  albumId: string;
};

export type LidarrAlbumLookupResult = {
  foreignAlbumId: string;
  title: string;
  overview: string;
  artistId: number;
  foreignArtistId: string;
  images: Array<{
    url: string;
    coverType: string;
  }>;
  releaseDate: string;
  artist: LidarrArtistLookupResult;
};

export type LidarrAlbum = {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  albumType: string;
  releaseDate: string;
};
