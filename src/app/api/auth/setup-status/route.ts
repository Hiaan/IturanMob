import { publicRoute } from "@/server/api/handler";
import { isFirstRun, registrationOpen } from "@/server/modules/households/service";

export const GET = publicRoute({}, async () => ({ firstRun: await isFirstRun(), registrationOpen: await registrationOpen() }));
