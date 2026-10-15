import { NotificationPreferencesForm } from "@/features/notifications/preferences-form";

// Rota TEMPORÁRIA apenas para validação visual — será removida.
export default function Preview() {
  return (
    <div className="mx-auto max-w-5xl">
      <NotificationPreferencesForm />
    </div>
  );
}
