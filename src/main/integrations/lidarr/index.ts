import { safeStorage, ipcMain, IpcMainEvent } from "electron";
import Conf from "conf";
import log from "electron-log";

import IIntegration from "../integration";
import { MemoryStoreSchema, StoreSchema } from "~shared/store/schema";
import MemoryStore from "../../memory-store";
import {
  AlbumLibraryInfo,
  LidarrAddArtistPayload,
  LidarrAlbum,
  LidarrAlbumLookupResult,
  LidarrArtistLookupResult,
  LidarrArtistResponse,
  LidarrMetadataProfile,
  LidarrQualityProfile,
  LidarrRootFolder
} from "./schemas";

export default class Lidarr implements IIntegration {
  private store: Conf<StoreSchema>;
  private memoryStore: MemoryStore<MemoryStoreSchema>;

  private isEnabled = false;
  private lidarrSettings: { url: string; apiKey: string | null } = null;

  // Cached profiles - fetched once per session
  private cachedQualityProfiles: LidarrQualityProfile[] | null = null;
  private cachedMetadataProfiles: LidarrMetadataProfile[] | null = null;
  private cachedRootFolders: LidarrRootFolder[] | null = null;

  private albumLibraryHandler: (event: IpcMainEvent, albumInfo: AlbumLibraryInfo) => void;

  public provide(store: Conf<StoreSchema>, memoryStore: MemoryStore<MemoryStoreSchema>): void {
    this.store = store;
    this.memoryStore = memoryStore;
  }

  public enable(): void {
    if (!this.memoryStore.get("safeStorageAvailable")) {
      log.info("Refusing to enable Lidarr Integration with reason: safeStorage unavailable");
      return;
    }

    if (this.isEnabled) {
      return;
    }

    this.lidarrSettings = this.getSettings();

    if (!this.lidarrSettings.url || !this.lidarrSettings.apiKey) {
      log.info("Lidarr Integration enabled but not configured - waiting for settings");
    }

    this.albumLibraryHandler = (_event: IpcMainEvent, albumInfo: AlbumLibraryInfo) => {
      this.handleAlbumAddedToLibrary(albumInfo);
    };

    ipcMain.on("ytmView:albumAddedToLibrary", this.albumLibraryHandler);
    this.isEnabled = true;
    log.info("Lidarr Integration enabled");
  }

  public disable(): void {
    if (!this.isEnabled) {
      return;
    }

    if (this.albumLibraryHandler) {
      ipcMain.removeListener("ytmView:albumAddedToLibrary", this.albumLibraryHandler);
    }

    this.isEnabled = false;
    log.info("Lidarr Integration disabled");
  }

  public getYTMScripts(): { name: string; script: string }[] {
    return [];
  }

  private async handleAlbumAddedToLibrary(albumInfo: AlbumLibraryInfo): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    // Refresh settings in case they changed
    this.lidarrSettings = this.getSettings();

    if (!this.lidarrSettings.url || !this.lidarrSettings.apiKey) {
      log.warn("Lidarr: Album added to library but Lidarr is not configured");
      return;
    }

    log.info(`Lidarr: Album "${albumInfo.album}" by "${albumInfo.artist}" added to library`);

    try {
      // Ensure we have cached profiles
      await this.ensureProfiles();

      // First, search for the album to get the foreignAlbumId
      // This is needed to properly tell Lidarr which album to monitor
      let foreignAlbumId: string | null = null;
      let artist: LidarrArtistLookupResult | null = null;

      try {
        const albums = await this.searchAlbum(`${albumInfo.artist} ${albumInfo.album}`);
        log.info(`Lidarr: Album search returned ${albums?.length || 0} results`);
        if (albums && albums.length > 0) {
          // Log first few results for debugging
          albums.slice(0, 3).forEach((a, i) => {
            log.info(`Lidarr: Album result ${i}: "${a.title}" by "${a.artist?.artistName}" (${a.foreignAlbumId})`);
          });

          // Find the best matching album
          const normalizedTitle = albumInfo.album.toLowerCase();
          const matchingAlbum = albums.find(a =>
            a.title.toLowerCase() === normalizedTitle ||
            a.title.toLowerCase().includes(normalizedTitle) ||
            normalizedTitle.includes(a.title.toLowerCase())
          ) || albums[0];

          foreignAlbumId = matchingAlbum.foreignAlbumId;
          artist = matchingAlbum.artist;
          log.info(`Lidarr: Selected album "${matchingAlbum.title}" (${foreignAlbumId})`);
        } else {
          log.warn(`Lidarr: No albums found in search results`);
        }
      } catch (albumSearchError) {
        log.warn(`Lidarr: Album search failed: ${albumSearchError.message}`);
      }

      // If album search didn't give us artist info, try artist search
      if (!artist) {
        try {
          const artists = await this.searchArtist(albumInfo.artist);
          if (artists && artists.length > 0) {
            artist = artists[0];
          }
        } catch (artistSearchError) {
          log.error(`Lidarr: Artist search also failed: ${artistSearchError.message}`);
          log.info(`Lidarr: Queued for later - Artist: "${albumInfo.artist}", Album: "${albumInfo.album}"`);
          return;
        }
      }

      if (!artist) {
        log.warn(`Lidarr: Could not find artist "${albumInfo.artist}" in Lidarr search`);
        return;
      }

      // Check if artist already exists in Lidarr
      const existingArtist = await this.getExistingArtist(artist.foreignArtistId);

      let artistId: number;

      if (existingArtist) {
        log.info(`Lidarr: Artist "${albumInfo.artist}" already exists in Lidarr`);
        artistId = existingArtist.id;
      } else {
        // Add the artist to Lidarr with the specific album to monitor
        const newArtist = await this.addArtist(artist, foreignAlbumId);
        log.info(`Lidarr: Successfully added artist "${albumInfo.artist}" to Lidarr`);
        artistId = newArtist.id;
      }

      // Monitor and search for just the specific album
      // This ensures the album is monitored even if addArtist had issues
      await this.monitorAndSearchAlbum(artistId, albumInfo.album);
    } catch (error) {
      log.error("Lidarr: Error processing album addition:", error);
    }
  }

  private async ensureProfiles(): Promise<void> {
    if (!this.cachedQualityProfiles) {
      this.cachedQualityProfiles = await this.fetchQualityProfiles();
    }
    if (!this.cachedMetadataProfiles) {
      this.cachedMetadataProfiles = await this.fetchMetadataProfiles();
    }
    if (!this.cachedRootFolders) {
      this.cachedRootFolders = await this.fetchRootFolders();
    }
  }

  private async fetchQualityProfiles(): Promise<LidarrQualityProfile[]> {
    const response = await this.lidarrFetch("/api/v1/qualityprofile");
    if (!response.ok) {
      throw new Error(`Failed to fetch quality profiles: ${response.statusText}`);
    }
    return response.json();
  }

  private async fetchMetadataProfiles(): Promise<LidarrMetadataProfile[]> {
    const response = await this.lidarrFetch("/api/v1/metadataprofile");
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata profiles: ${response.statusText}`);
    }
    return response.json();
  }

  private async fetchRootFolders(): Promise<LidarrRootFolder[]> {
    const response = await this.lidarrFetch("/api/v1/rootfolder");
    if (!response.ok) {
      throw new Error(`Failed to fetch root folders: ${response.statusText}`);
    }
    return response.json();
  }

  private async searchArtist(artistName: string): Promise<LidarrArtistLookupResult[]> {
    const endpoint = `/api/v1/artist/lookup?term=${encodeURIComponent(artistName)}`;
    log.info(`Lidarr: Searching for artist at ${this.lidarrSettings.url}${endpoint}`);
    const response = await this.lidarrFetch(endpoint);
    if (!response.ok) {
      log.error(`Lidarr: Search failed with status ${response.status} ${response.statusText}`);
      throw new Error(`Failed to search for artist: ${response.statusText}`);
    }
    return response.json();
  }

  private async searchAlbum(searchTerm: string): Promise<LidarrAlbumLookupResult[]> {
    const endpoint = `/api/v1/album/lookup?term=${encodeURIComponent(searchTerm)}`;
    log.info(`Lidarr: Searching for album at ${this.lidarrSettings.url}${endpoint}`);
    const response = await this.lidarrFetch(endpoint);
    if (!response.ok) {
      log.error(`Lidarr: Album search failed with status ${response.status} ${response.statusText}`);
      throw new Error(`Failed to search for album: ${response.statusText}`);
    }
    return response.json();
  }

  private async getArtistAlbums(artistId: number): Promise<LidarrAlbum[]> {
    const response = await this.lidarrFetch(`/api/v1/album?artistId=${artistId}`);
    if (!response.ok) {
      throw new Error(`Failed to get artist albums: ${response.statusText}`);
    }
    return response.json();
  }

  private async monitorAndSearchAlbum(artistId: number, albumTitle: string): Promise<void> {
    // Wait a bit for Lidarr to sync album data after adding artist
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get all albums for this artist (with retry)
    let albums = await this.getArtistAlbums(artistId);

    // If no albums found, wait longer and retry (Lidarr may still be syncing)
    if (!albums || albums.length === 0) {
      log.info("Lidarr: No albums found yet, waiting for sync...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      albums = await this.getArtistAlbums(artistId);
    }

    log.info(`Lidarr: Found ${albums.length} albums for artist`);

    // Find the album by title (case-insensitive partial match)
    const normalizedTitle = albumTitle.toLowerCase().trim();
    const album = albums.find(a => {
      const lidarrTitle = (a.title || "").toLowerCase().trim();
      return lidarrTitle === normalizedTitle ||
        lidarrTitle.includes(normalizedTitle) ||
        normalizedTitle.includes(lidarrTitle);
    });

    if (!album) {
      log.warn(`Lidarr: Could not find album "${albumTitle}" in artist's discography`);
      // Log first 10 album titles for debugging
      const availableTitles = albums.slice(0, 10).map(a => a.title || "(no title)");
      log.info(`Lidarr: First 10 available albums: ${availableTitles.join(", ")}`);
      return;
    }

    // Update the album to be monitored
    const updateResponse = await this.lidarrFetch(`/api/v1/album/${album.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...album,
        monitored: true
      })
    });

    if (!updateResponse.ok) {
      throw new Error(`Failed to monitor album: ${updateResponse.statusText}`);
    }

    log.info(`Lidarr: Set album "${album.title}" to monitored`);

    // Trigger search for this specific album
    const searchResponse = await this.lidarrFetch("/api/v1/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "AlbumSearch",
        albumIds: [album.id]
      })
    });

    if (!searchResponse.ok) {
      throw new Error(`Failed to trigger album search: ${searchResponse.statusText}`);
    }

    log.info(`Lidarr: Triggered search for album "${album.title}"`);
  }

  private async getExistingArtist(foreignArtistId: string): Promise<LidarrArtistResponse | null> {
    try {
      const response = await this.lidarrFetch("/api/v1/artist");
      if (!response.ok) {
        return null;
      }
      const artists: LidarrArtistResponse[] = await response.json();
      return artists.find(a => a.foreignArtistId === foreignArtistId) || null;
    } catch {
      return null;
    }
  }

  private async searchArtistAlbums(artistId: number): Promise<void> {
    const response = await this.lidarrFetch("/api/v1/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "ArtistSearch",
        artistId: artistId
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to trigger artist search: ${response.statusText}`);
    }
  }

  private async addArtist(artist: LidarrArtistLookupResult, foreignAlbumId?: string | null): Promise<LidarrArtistResponse> {
    if (!this.cachedQualityProfiles?.length || !this.cachedMetadataProfiles?.length || !this.cachedRootFolders?.length) {
      throw new Error("Missing required profiles or root folders");
    }

    const payload: LidarrAddArtistPayload = {
      ...artist,
      qualityProfileId: this.cachedQualityProfiles[0].id,
      metadataProfileId: this.cachedMetadataProfiles[0].id,
      rootFolderPath: this.cachedRootFolders[0].path,
      monitored: true,
      addOptions: {
        // "Existing" only monitors albums already on disk (none for new artist)
        // AlbumsToMonitor adds our specific album to be monitored
        // This is the correct solution per Lidarr GitHub issue #3597
        monitor: "existing",
        searchForMissingAlbums: false,
        AlbumsToMonitor: foreignAlbumId ? [foreignAlbumId] : []
      }
    };

    log.info(`Lidarr: Adding artist with foreignAlbumId: ${foreignAlbumId || "none"}`);
    log.info(`Lidarr: Payload addOptions: ${JSON.stringify(payload.addOptions)}`);

    const response = await this.lidarrFetch("/api/v1/artist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add artist: ${response.statusText} - ${errorText}`);
    }

    return response.json();
  }

  private async lidarrFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = this.lidarrSettings.url.replace(/\/$/, "") + endpoint;

    return fetch(url, {
      ...options,
      headers: {
        "X-Api-Key": this.lidarrSettings.apiKey,
        ...options.headers
      }
    });
  }

  public async testConnection(): Promise<{ success: boolean; message: string }> {
    this.lidarrSettings = this.getSettings();

    if (!this.lidarrSettings.url) {
      return { success: false, message: "Lidarr URL is not configured" };
    }

    if (!this.lidarrSettings.apiKey) {
      return { success: false, message: "Lidarr API key is not configured" };
    }

    try {
      const response = await this.lidarrFetch("/api/v1/system/status");

      if (!response.ok) {
        if (response.status === 401) {
          return { success: false, message: "Invalid API key" };
        }
        return { success: false, message: `Connection failed: ${response.statusText}` };
      }

      // Clear cached profiles so they get refreshed
      this.cachedQualityProfiles = null;
      this.cachedMetadataProfiles = null;
      this.cachedRootFolders = null;

      return { success: true, message: "Connection successful" };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error.message}` };
    }
  }

  private getSettings(): { url: string; apiKey: string | null } {
    const settings = this.store.get("lidarr");

    let apiKey = settings.apiKey;
    if (apiKey) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(apiKey, "hex"));
      } catch (e) {
        apiKey = null;
        log.error("Lidarr: Failed to decrypt API key:", e);
      }
    }

    return {
      url: settings.url,
      apiKey
    };
  }

  public saveApiKey(apiKey: string): void {
    try {
      const encrypted = safeStorage.encryptString(apiKey).toString("hex");
      this.store.set("lidarr.apiKey", encrypted);
    } catch (e) {
      log.error("Lidarr: Failed to encrypt API key:", e);
    }
  }
}
