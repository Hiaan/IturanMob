"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock,
  FileText,
  Image as ImageIcon,
  Inbox,
  Link2Off,
  LoaderCircle,
  LogOut,
  MessageCircleQuestion,
  MessageSquareText,
  Mic,
  MinusCircle,
  QrCode,
  SmilePlus,
  Sticker,
  Video,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MESSAGE_STATUS_LABELS, WHATSAPP_STATUS_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { WaConnectionStatus, WaMessageStatus, WaMessageType, WaProvider } from "./types";

type Tone = "positive" | "negative" | "warning" | "info" | "muted";

export const TONE_TEXT: Record<Tone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  info: "text-info",
  muted: "text-muted-foreground",
};

export const TONE_SOFT_BG: Record<Tone, string> = {
  positive: "bg-positive/12 text-positive",
  negative: "bg-negative/12 text-negative",
  warning: "bg-warning/12 text-warning",
  info: "bg-info/12 text-info",
  muted: "bg-muted text-muted-foreground",
};

export const CONNECTION_META: Record<WaConnectionStatus, { label: string; tone: Tone; icon: LucideIcon; spin?: boolean; hint: string }> = {
  CONNECTED: { label: WHATSAPP_STATUS_LABELS.CONNECTED, tone: "positive", icon: CheckCircle2, hint: "Recebendo as mensagens do chat autorizado." },
  CONNECTING: { label: WHATSAPP_STATUS_LABELS.CONNECTING, tone: "info", icon: LoaderCircle, spin: true, hint: "O worker está abrindo a conexão." },
  QR_PENDING: { label: WHATSAPP_STATUS_LABELS.QR_PENDING, tone: "warning", icon: QrCode, hint: "Leia o QR Code com o celular para concluir." },
  DISCONNECTED: { label: WHATSAPP_STATUS_LABELS.DISCONNECTED, tone: "muted", icon: WifiOff, hint: "Nenhuma mensagem está sendo recebida." },
  ERROR: { label: WHATSAPP_STATUS_LABELS.ERROR, tone: "negative", icon: AlertTriangle, hint: "A conexão falhou. Veja o histórico de eventos." },
  LOGGED_OUT: { label: WHATSAPP_STATUS_LABELS.LOGGED_OUT, tone: "warning", icon: LogOut, hint: "A sessão foi encerrada. Conecte novamente." },
};

export const MESSAGE_STATUS_META: Record<WaMessageStatus, { label: string; tone: Tone; icon: LucideIcon; spin?: boolean }> = {
  RECEIVED: { label: MESSAGE_STATUS_LABELS.RECEIVED, tone: "muted", icon: Inbox },
  QUEUED: { label: MESSAGE_STATUS_LABELS.QUEUED, tone: "info", icon: Clock },
  PROCESSING: { label: MESSAGE_STATUS_LABELS.PROCESSING, tone: "info", icon: LoaderCircle, spin: true },
  PROCESSED: { label: MESSAGE_STATUS_LABELS.PROCESSED, tone: "positive", icon: CheckCircle2 },
  IGNORED: { label: MESSAGE_STATUS_LABELS.IGNORED, tone: "muted", icon: MinusCircle },
  NEEDS_CLARIFICATION: { label: MESSAGE_STATUS_LABELS.NEEDS_CLARIFICATION, tone: "warning", icon: MessageCircleQuestion },
  FAILED: { label: MESSAGE_STATUS_LABELS.FAILED, tone: "negative", icon: XCircle },
};

export const MESSAGE_STATUS_ORDER: WaMessageStatus[] = ["PROCESSED", "NEEDS_CLARIFICATION", "FAILED", "QUEUED", "PROCESSING", "RECEIVED", "IGNORED"];

export const MESSAGE_TYPE_META: Record<WaMessageType, { label: string; icon: LucideIcon }> = {
  TEXT: { label: "Texto", icon: MessageSquareText },
  AUDIO: { label: "Áudio", icon: Mic },
  IMAGE: { label: "Imagem", icon: ImageIcon },
  DOCUMENT: { label: "Documento", icon: FileText },
  VIDEO: { label: "Vídeo", icon: Video },
  STICKER: { label: "Figurinha", icon: Sticker },
  REACTION: { label: "Reação", icon: SmilePlus },
  OTHER: { label: "Outro", icon: CircleHelp },
};

export const PROVIDER_SHORT: Record<WaProvider, string> = {
  SIMULATOR: "Simulador",
  BAILEYS: "Baileys (QR Code)",
  CLOUD_API: "API oficial (Cloud)",
};

export const EVENT_META: Record<string, { label: string; tone: Tone; icon: LucideIcon }> = {
  CONNECTED: { label: "Conectado", tone: "positive", icon: CheckCircle2 },
  DISCONNECTED: { label: "Desconectado", tone: "muted", icon: Link2Off },
  QR: { label: "QR Code", tone: "info", icon: QrCode },
  ERROR: { label: "Erro", tone: "negative", icon: AlertTriangle },
  LOGGED_OUT: { label: "Sessão encerrada", tone: "warning", icon: LogOut },
};

export function ConnectionBadge({ status, className }: { status: WaConnectionStatus; className?: string }) {
  const meta = CONNECTION_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.tone === "muted" ? "muted" : meta.tone} className={className}>
      <Icon className={cn(meta.spin && "animate-spin")} aria-hidden />
      {meta.label}
    </Badge>
  );
}

export function MessageStatusBadge({ status, className }: { status: WaMessageStatus; className?: string }) {
  const meta = MESSAGE_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.tone === "muted" ? "muted" : meta.tone} className={className}>
      <Icon className={cn(meta.spin && "animate-spin")} aria-hidden />
      {meta.label}
    </Badge>
  );
}
