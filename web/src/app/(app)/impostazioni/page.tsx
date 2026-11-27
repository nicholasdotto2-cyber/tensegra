import { redirect } from "next/navigation";

// /impostazioni porta alla prima sezione: la sidebar punta già a Studio, qui
// c'è chi scrive l'indirizzo a mano.
export default function SettingsIndexPage() {
  redirect("/impostazioni/studio");
}
