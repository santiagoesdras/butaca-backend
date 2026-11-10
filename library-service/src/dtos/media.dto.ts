import { MediaType, ProgressStatus } from "../db.js";

export type ApiMediaType = "movie" | "tv";
export type ApiProgressStatus = "in_progress" | "completed" | "on_hold" | "dropped";

export interface ProgressDto {
  tmdb_id: number;
  media_type: ApiMediaType;
  status: ApiProgressStatus;
  position_seconds?: number | null;
  duration_seconds?: number | null;
}

export interface WatchlistDto {
  tmdb_id: number;
  media_type: ApiMediaType;
  created_at: string;
}

export interface FavoriteDto {
  tmdb_id: number;
  media_type: ApiMediaType;
  created_at: string;
}

export function toPrismaMediaType(apiType: ApiMediaType | string): MediaType {
  const normalized = apiType.toLowerCase();
  if (normalized === "movie") return MediaType.MOVIE;
  if (normalized === "tv") return MediaType.TV;
  throw new Error(`Tipo de medio inválido: ${apiType}`);
}

export function toApiMediaType(prismaType: MediaType): ApiMediaType {
  switch (prismaType) {
    case MediaType.MOVIE:
      return "movie";
    case MediaType.TV:
      return "tv";
    default:
      return "movie";
  }
}

export function toPrismaProgressStatus(apiStatus: ApiProgressStatus | string): ProgressStatus {
  const normalized = apiStatus.toLowerCase();
  switch (normalized) {
    case "in_progress":
      return ProgressStatus.IN_PROGRESS;
    case "completed":
      return ProgressStatus.COMPLETED;
    case "on_hold":
      return ProgressStatus.ON_HOLD;
    case "dropped":
      return ProgressStatus.DROPPED;
    default:
      throw new Error(`Estado de progreso inválido: ${apiStatus}`);
  }
}

export function toApiProgressStatus(prismaStatus: ProgressStatus): ApiProgressStatus {
  switch (prismaStatus) {
    case ProgressStatus.IN_PROGRESS:
      return "in_progress";
    case ProgressStatus.COMPLETED:
      return "completed";
    case ProgressStatus.ON_HOLD:
      return "on_hold";
    case ProgressStatus.DROPPED:
      return "dropped";
    default:
      return "in_progress";
  }
}
