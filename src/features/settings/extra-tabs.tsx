import type { LucideIcon } from "lucide-react";
import { DatabaseBackup, FileLock2 } from "lucide-react";
import { DataPrivacySection } from "./data-privacy-section";
import { BackupsSection } from "./backups-section";

/** Abas adicionais de Configurações fornecidas por outros módulos (dados/LGPD e backups). */
export const SETTINGS_EXTRA_TABS: Array<{ value: string; label: string; icon: LucideIcon; permission?: string; Component: () => React.ReactNode }> = [
  { value: "dados", label: "Dados e LGPD", icon: FileLock2, Component: DataPrivacySection },
  { value: "backups", label: "Backups", icon: DatabaseBackup, permission: "settings:manage", Component: BackupsSection },
];
