/** Tipos de resposta da API da agenda (espelham src/server/modules/agenda/service.ts e google.ts). */
export type AppointmentVisibility = "SHARED" | "PRIVATE";
export type AppointmentSource = "MANUAL" | "WHATSAPP" | "GOOGLE";

export interface AppointmentDTO {
  id: string;
  title: string;
  /** AAAA-MM-DD (no fuso da família). */
  date: string;
  /** "HH:MM"; null = dia todo. */
  time: string | null;
  endTime: string | null;
  allDay: boolean;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  notes: string | null;
  visibility: AppointmentVisibility;
  owner: { id: string; name: string } | null;
  /** Minutos antes para avisar (null = sem lembrete). */
  reminderMinutes: number | null;
  source: AppointmentSource;
  /** Vindo do Google Agenda: só leitura aqui. */
  readOnly: boolean;
}

export interface AppointmentInput {
  title: string;
  date: string;
  time: string | null;
  endTime: string | null;
  location: string | null;
  notes: string | null;
  visibility: AppointmentVisibility;
  reminderMinutes: number | null;
}

export interface GoogleStatusDTO {
  appConfigured: boolean;
  clientIdHint: string | null;
  redirectUri: string;
  simulatorAvailable: boolean;
  canManageApp: boolean;
  me: {
    connected: boolean;
    simulated: boolean;
    email: string | null;
    shareWithFamily: boolean;
    lastSyncAt: string | null;
    lastError: string | null;
    events: number;
  } | null;
  connectedMembers: Array<{ memberId: string; name: string; simulated: boolean }>;
}
