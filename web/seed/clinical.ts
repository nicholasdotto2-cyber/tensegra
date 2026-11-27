import { type RegionCode, SYSTEMS, type ScreeningGroup } from "@/lib/clinical/catalog";
import { dayField } from "@/lib/format";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { addDaysRome, type Clock, fixedClock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { addPsfsItem, updateCycleOpening } from "@/server/domain/cycles/commands";
import { saveHistoryItem, saveLifestyle, saveSystemsReview } from "@/server/domain/history/commands";
import { createReferral, markReferralDelivered, updateReferral } from "@/server/domain/referrals/commands";
import { getReferralLetter } from "@/server/domain/referrals/queries";
import { closeVisit, editVisit, startVisit } from "@/server/domain/visits/commands";
import type { EditVisitInput } from "@/server/domain/visits/schemas";
import { endOf } from "./dates";
import type { Seeded } from "./demo";

// Il contenuto clinico della demo per i suoi passi 4 e 5: Marco, Anna, Roberto
// e Giulia; Matteo, Francesca e Valentina perché le loro schede non mostrino "Seduta senza visita";
// Davide, Chiara, Giorgio, Martina, Lorenzo, Paolo e il rinvio in bozza di Valentina col seed
// clinico completo. Tutto passa dai comandi della cartella come l'utente demo, nella transazione del seed, con un
// orologio per evento: la visita di un fatto si apre, si compila e si chiude alla fine del suo appuntamento
// (anche i campi d'apertura e le attività PSFS, che dopo la chiusura della prima visita passano dalla
// rettifica); la bozza di oggi di Anna nasce all'istante del seed, così niente è nel futuro.
// I testi che lo scenario della demo non fissa sono proposti e vanno riletti con un osteopata.

const P = DEMO_PRACTICE_ID;

type Appointment = Seeded["appointments"][number];
type VisitOp = EditVisitInput["op"];

/** I gruppi dello screening sempre visibili. */
const ALWAYS_VISIBLE: readonly ScreeningGroup[] = ["ci_sistemica", "ci_locale", "rf_rachide"];
const ALL_INDICATED: VisitOp = {
  op: "esiti",
  outcomes: [
    { family: "thrust", outcome: "indicated" },
    { family: "direct", outcome: "indicated" },
    { family: "indirect", outcome: "indicated" },
  ],
};

function patientNamed(seeded: readonly Seeded[], firstName: string, lastName: string): Seeded {
  const found = seeded.find((s) => s.patient.firstName === firstName && s.patient.lastName === lastName);
  if (!found) throw new Error(`Il seed clinico non trova ${firstName} ${lastName}.`);
  return found;
}

/** Gli appuntamenti `fatto` del paziente, in ordine di data. */
function done(s: Seeded): Appointment[] {
  return s.appointments.filter((a) => a.seed.status === "fatto");
}

/** L'orologio della fine dell'appuntamento: l'istante della visita di un fatto. */
const endClock = (a: Appointment): Clock => fixedClock(endOf(a));

/** Le operazioni della visita in ordine, con lo stesso orologio. */
async function edit(tx: Tx, clock: Clock, visitId: string, ops: readonly VisitOp[]): Promise<void> {
  for (const op of ops) await editVisit(tx, P, clock, { visitId, op });
}

/** "Nessun'altra voce" sui gruppi dati: "no" su ogni voce senza risposta. */
const noOtherItem = (groups: readonly ScreeningGroup[]): VisitOp[] =>
  groups.map((group) => ({ op: "nessun_altra_voce", group }));

/** Le attività PSFS del ciclo alla prima visita, ciascuna con il suo punteggio iniziale. */
async function addPsfs(
  tx: Tx,
  clock: Clock,
  cycleId: string,
  visitId: string,
  items: readonly (readonly [activity: string, score: number])[],
): Promise<void> {
  for (const [activity, score] of items) {
    const { id } = await addPsfsItem(tx, P, clock, { cycleId, activity });
    await edit(tx, clock, visitId, [{ op: "psfs", itemId: id, score }]);
  }
}

const closeIt = (tx: Tx, clock: Clock, visitId: string) =>
  closeVisit(tx, P, clock, { visitId, confirmCopied: false, alsoMarkDone: false });

/**
 * Marco, prima visita del P(10): ciclo «Cervicalgia con cefalea» con obiettivo, piano accettato e tre attività
 * PSFS; apparati senza segnalazioni salvo il sonno; screening con "Nessun'altra voce" sui quattro gruppi
 * visibili (la regione principale cervicale apre il gruppo cervicale) e tre esiti indicati; PA, dolore,
 * disfunzioni, test, tecniche, risposta e il consiglio delle pause attive. Su questa visita il passo 4 copia
 * («Nessuna variazione» e "Copia dalla visita precedente").
 */
async function seedMarco(tx: Tx, s: Seeded): Promise<void> {
  const [first] = done(s);
  if (!first) throw new Error("Marco non ha la prima visita fatta.");
  const clock = endClock(first);
  const { visitId } = await startVisit(tx, P, clock, { appointmentId: first.id });

  await updateCycleOpening(tx, P, clock, {
    cycleId: s.cycleId,
    chiefComplaint: "Cervicalgia con cefalea che parte dalla nuca, lavorando al computer",
    mainRegion: "cervical",
    goal: "Lavorare al computer 2 ore senza dolore",
    planAgreedOn: first.day,
  });
  await addPsfs(tx, clock, s.cycleId, visitId, [
    ["Lavorare al computer 2 ore", 4],
    ["Guidare 30 minuti", 5],
    ["Dormire sul fianco destro", 3],
  ]);
  await saveSystemsReview(tx, P, clock, {
    patientId: s.patientId,
    reviewedOn: first.day,
    rows: SYSTEMS.map((system) =>
      system.code === "sonno"
        ? { system: system.code, status: "da_segnalare", note: "Si sveglia con la nuca rigida" }
        : { system: system.code, status: "nulla", note: null },
    ),
  });

  await edit(tx, clock, visitId, [
    { op: "campi", values: { nprsPre: 7, bpSystolic: 125, bpDiastolic: 80 } },
    ...noOtherItem([...ALWAYS_VISIBLE, "rf_cervicale_vascolare"]),
    ALL_INDICATED,
    {
      op: "disfunzione",
      region: "cervical",
      severity: 3,
      tissueTexture: true,
      restriction: true,
      tenderness: true,
      side: "dx",
      segmentNote: "C2-C3 dx",
      isPrimary: true,
    },
    { op: "disfunzione", region: "thoracic", severity: 2, asymmetry: true, restriction: true },
    ...(["dx", "sx"] as const).flatMap((side): VisitOp[] => [
      { op: "test", testCode: "flessione_rotazione", side, valueNumeric: side === "dx" ? 28 : 40 },
      { op: "test", testCode: "spurling", side, valueBool: false },
      { op: "test", testCode: "riflesso_bicipitale", side, valueOrdinal: 0 },
      { op: "test", testCode: "riflesso_tricipitale", side, valueOrdinal: 0 },
    ]),
    { op: "tecnica", region: "cervical", techniqueCode: "tessuti_molli" },
    { op: "tecnica", region: "cervical", techniqueCode: "energia_muscolare" },
    { op: "tecnica", region: "thoracic", techniqueCode: "articolatoria" },
    { op: "campi", values: { treatmentResponse: "migliorato", nprsPost: 4 } },
    { op: "consiglio", templateCode: "pause_attive", communicatedVia: ["a_voce"] },
  ]);
  await closeIt(tx, clock, visitId);
}

/**
 * Lo screening di Anna: `ci_avk` arriva "si" dall'anamnesi all'avvio della visita, "Nessun'altra
 * voce" sui tre gruppi, thrust controindicato, dirette con cautela con la nota dell'INR, indirette indicate.
 */
function annaScreening(inrNote: string): VisitOp[] {
  return [
    ...noOtherItem(ALWAYS_VISIBLE),
    {
      op: "esiti",
      outcomes: [
        { family: "thrust", outcome: "contraindicated" },
        { family: "direct", outcome: "caution", overrideNote: inrNote },
        { family: "indirect", outcome: "indicated" },
      ],
    },
  ];
}

const LUMBAR_2: VisitOp = { op: "disfunzione", region: "lumbar", severity: 2 };

/**
 * Anna: il Warfarin nell'anamnesi prima di ogni visita (così `ci_avk` nasce "da anamnesi" e nessuna scrittura
 * dell'anamnesi toglie dopo la conferma della bozza); due controlli chiusi con funzionale e tessuti
 * molli lombari; la visita di oggi aperta in bozza all'istante del seed con lo screening confermato, la nota
 * nuova dell'INR del giorno prima e la lombare, senza tecniche (passo 5: HVLA disattivata con il motivo).
 */
async function seedAnna(tx: Tx, seedClock: Clock, s: Seeded): Promise<void> {
  const past = done(s);
  const today = s.appointments.find((a) => a.day === seedClock.today());
  const [first] = past;
  if (past.length !== 2 || !first || !today) throw new Error("Anna ha due controlli fatti e quello di oggi.");

  await saveHistoryItem(tx, P, endClock(first), {
    patientId: s.patientId,
    kind: "farmaco",
    label: "Warfarin 5 mg",
    region: null,
    occurredOn: null,
    occurredYear: null,
    ongoing: true,
    note: null,
  });

  for (const [i, appointment] of past.entries()) {
    const clock = endClock(appointment);
    const { visitId } = await startVisit(tx, P, clock, { appointmentId: appointment.id });
    if (i === 0) await updateCycleOpening(tx, P, clock, { cycleId: s.cycleId, goal: "Mantenere la schiena mobile" });
    await edit(tx, clock, visitId, [
      { op: "campi", values: { nprsPre: i === 0 ? 4 : 3 } },
      ...annaScreening("INR 2,4 di due giorni prima, dal libretto TAO"),
      LUMBAR_2,
      { op: "tecnica", region: "lumbar", techniqueCode: "funzionale" },
      { op: "tecnica", region: "lumbar", techniqueCode: "tessuti_molli" },
    ]);
    await closeIt(tx, clock, visitId);
  }

  const { visitId } = await startVisit(tx, P, seedClock, { appointmentId: today.id });
  const yesterday = dayField(addDaysRome(seedClock.today(), -1));
  await edit(tx, seedClock, visitId, [...annaScreening(`INR 2,5 del ${yesterday} dal libretto TAO`), LUMBAR_2]);
}

/**
 * Roberto, prima visita del D0-21: dolore non meccanico e calo di peso (R1), nessuna tecnica; poi il rinvio
 * programmato al suo medico curante con la sintesi generata, l'assenso e la consegna al paziente lo stesso
 * giorno. Il PDF nasce alla prima richiesta della sua route. Il ciclo lo chiude `closeCycles`
 * come "rinviato al medico".
 */
async function seedRoberto(tx: Tx, s: Seeded): Promise<void> {
  const [first] = done(s);
  if (!first) throw new Error("Roberto non ha la prima visita fatta.");
  const clock = endClock(first);
  const { visitId } = await startVisit(tx, P, clock, { appointmentId: first.id });
  await updateCycleOpening(tx, P, clock, {
    cycleId: s.cycleId,
    chiefComplaint: "Dolore dorsale e lombare",
    mainRegion: "thoracic",
    goal: "Ridurre il dolore dorsale e lombare",
  });
  await edit(tx, clock, visitId, [
    { op: "campi", values: { nprsPre: 6 } },
    { op: "risposta", itemCode: "rf_nonmech", answer: "si" },
    { op: "risposta", itemCode: "rf_weight", answer: "si" },
    ...noOtherItem(ALWAYS_VISIBLE),
    ALL_INDICATED,
  ]);
  await closeIt(tx, clock, visitId);

  const { id: referralId } = await createReferral(tx, P, clock, {
    patientId: s.patientId,
    visitId,
    reason: "red_flag",
    urgency: "programmato",
  });
  const letter = await getReferralLetter(tx, P, referralId);
  if (!letter) throw new Error("Il rinvio di Roberto non si rilegge.");
  await updateReferral(tx, P, clock, {
    referralId,
    recipientKind: letter.recipient.kind,
    physicianId: letter.recipient.physicianId,
    recipientFree: letter.recipient.free,
    reason: letter.reason,
    urgency: letter.urgency,
    summaryText: letter.summaryText,
    requestText: letter.requestText,
    patientAgreedToShare: true,
  });
  await markReferralDelivered(tx, P, clock, { referralId, deliveredOn: first.day });
}

/** Le tre sedute di Giulia della demo: dolore a inizio seduta, dita-pavimento, TFE, lombare e sacro. */
const GIULIA_VISITS = [
  { pain: 7, fingerFloor: 28, tfe: "dx", lumbar: 3, sacral: 2 },
  { pain: 5, fingerFloor: 18, tfe: "dx", lumbar: 2, sacral: 1 },
  { pain: 3, fingerFloor: 10, tfe: "neg", lumbar: 1, sacral: 1 },
] as const;

/**
 * Giulia: la prima visita apre il ciclo (regione lombare, obiettivo, tre attività PSFS con l'iniziale) con
 * "Nessun'altra voce" e tre esiti indicati; le due sedute dopo confermano lo screening con «Nessuna variazione».
 * A ogni visita i test e i tessuti molli lombari ("Test nel tempo" del passo 9).
 */
async function seedGiulia(tx: Tx, s: Seeded): Promise<void> {
  const past = done(s);
  if (past.length !== GIULIA_VISITS.length) throw new Error("Giulia ha tre sedute fatte.");
  for (const [i, appointment] of past.entries()) {
    const values = GIULIA_VISITS[i];
    if (!values) continue;
    const clock = endClock(appointment);
    const { visitId } = await startVisit(tx, P, clock, { appointmentId: appointment.id });
    if (i === 0) {
      await updateCycleOpening(tx, P, clock, {
        cycleId: s.cycleId,
        chiefComplaint: "Lombalgia",
        mainRegion: "lumbar",
        goal: "Allacciarsi le scarpe senza dolore",
      });
      await addPsfs(tx, clock, s.cycleId, visitId, [
        ["Guidare 30 minuti", 4],
        ["Dormire sul fianco destro", 3],
        ["Allacciarmi le scarpe", 5],
      ]);
    }
    await edit(tx, clock, visitId, [
      { op: "campi", values: { nprsPre: values.pain } },
      ...(i === 0 ? [...noOtherItem(ALWAYS_VISIBLE), ALL_INDICATED] : [{ op: "nessuna_variazione" } as const]),
      { op: "disfunzione", region: "lumbar", severity: values.lumbar },
      { op: "disfunzione", region: "sacral", severity: values.sacral },
      { op: "test", testCode: "dita_pavimento", valueNumeric: values.fingerFloor },
      { op: "test", testCode: "flessione_in_piedi", valueLateral: values.tfe },
      { op: "tecnica", region: "lumbar", techniqueCode: "tessuti_molli" },
    ]);
    await closeIt(tx, clock, visitId);
  }
}

/** Ciò che una prima visita aggiunge allo schema comune: gruppi dello screening aperti dall'anamnesi, attività PSFS, bozza. */
interface FirstVisitExtra {
  /** I gruppi visibili oltre a quelli sempre visibili e al cervicale della regione principale (la gravidanza di Chiara). */
  groups?: readonly ScreeningGroup[];
  /** Le attività PSFS con il punteggio iniziale, scritte prima della chiusura. */
  psfs?: readonly (readonly [activity: string, score: number])[];
  /** La visita resta in bozza: è l'ultima del ciclo e la chiude `closeCycles` dopo i punteggi finali. */
  keepOpen?: boolean;
}

/**
 * La prima visita di un ciclo di trattamento, sullo schema di `seedMarco`: motivo, regione principale,
 * obiettivo e piano accettato (quello che la chiusura della prima visita chiede), le attività PSFS se ci sono,
 * "Nessun'altra voce" sui gruppi visibili e tre esiti indicati, poi le operazioni del paziente e la chiusura.
 * Torna l'id della visita.
 */
async function seedFirstVisit(
  tx: Tx,
  s: Seeded,
  appointment: Appointment,
  opening: { chiefComplaint: string; mainRegion: RegionCode; goal: string },
  ops: readonly VisitOp[],
  extra: FirstVisitExtra = {},
): Promise<string> {
  const clock = endClock(appointment);
  const { visitId } = await startVisit(tx, P, clock, { appointmentId: appointment.id });
  await updateCycleOpening(tx, P, clock, { cycleId: s.cycleId, ...opening, planAgreedOn: appointment.day });
  if (extra.psfs) await addPsfs(tx, clock, s.cycleId, visitId, extra.psfs);
  const groups: ScreeningGroup[] = [
    ...ALWAYS_VISIBLE,
    ...(opening.mainRegion === "cervical" ? (["rf_cervicale_vascolare"] as const) : []),
    ...(extra.groups ?? []),
  ];
  await edit(tx, clock, visitId, [...noOtherItem(groups), ALL_INDICATED, ...ops]);
  if (!extra.keepOpen) await closeIt(tx, clock, visitId);
  return visitId;
}

/**
 * Una seduta dopo la prima con lo screening confermato da «Nessuna variazione», le operazioni del
 * paziente e la chiusura alla fine del suo appuntamento; `keepOpen` lascia in bozza l'ultima seduta di un
 * ciclo che `closeCycles` chiude con i punteggi finali. Torna l'id della visita.
 */
async function seedFollowUp(tx: Tx, appointment: Appointment, ops: readonly VisitOp[], keepOpen = false): Promise<string> {
  const clock = endClock(appointment);
  const { visitId } = await startVisit(tx, P, clock, { appointmentId: appointment.id });
  await edit(tx, clock, visitId, [{ op: "nessuna_variazione" }, ...ops]);
  if (!keepOpen) await closeIt(tx, clock, visitId);
  return visitId;
}

/** Gli appuntamenti fatti del paziente, quanti ne vuole la demo. */
function doneExactly(s: Seeded, count: number): Appointment[] {
  const past = done(s);
  if (past.length !== count) throw new Error(`${s.patient.firstName} ${s.patient.lastName} ha ${count} appuntamenti fatti.`);
  return past;
}

/** Matteo, prima visita del P(2): arto inferiore dx severità 2, Thomas modificato e Ober dx positivi, dolore 4. */
async function seedMatteo(tx: Tx, s: Seeded): Promise<void> {
  const [first] = doneExactly(s, 1);
  if (!first) return;
  await seedFirstVisit(
    tx,
    s,
    first,
    {
      chiefComplaint: "Dolore al ginocchio destro andando in bicicletta",
      mainRegion: "lower_extremity",
      goal: "Pedalare un'ora senza dolore al ginocchio",
    },
    [
      { op: "campi", values: { nprsPre: 4 } },
      { op: "disfunzione", region: "lower_extremity", severity: 2, side: "dx" },
      { op: "test", testCode: "thomas_modificato", side: "dx", valueBool: true },
      { op: "test", testCode: "ober", side: "dx", valueBool: true },
    ],
  );
}

/** Francesca, prima visita del D0-14: regione principale cervicale, dolore 5, rotazione cervicale attiva. */
async function seedFrancesca(tx: Tx, s: Seeded): Promise<void> {
  const [first] = doneExactly(s, 1);
  if (!first) return;
  await seedFirstVisit(
    tx,
    s,
    first,
    { chiefComplaint: "Cefalea di tipo tensivo", mainRegion: "cervical", goal: "Arrivare a fine giornata senza mal di testa" },
    [
      { op: "campi", values: { nprsPre: 5 } },
      { op: "test", testCode: "rom_rotazione_cervicale", side: "dx", valueNumeric: 60 },
      { op: "test", testCode: "rom_rotazione_cervicale", side: "sx", valueNumeric: 65 },
    ],
  );
}

/** Il medico di famiglia della rubrica della demo, destinatario del rinvio in bozza di Valentina. */
async function physicianNamed(tx: Tx, fullName: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>("select id from public.physicians where practice_id = $1 and full_name = $2", [
    P,
    fullName,
  ]);
  if (!row) throw new Error(`Nella rubrica del seed manca ${fullName}.`);
  return row.id;
}

/**
 * Valentina: la prima visita del D0-17 con dolore 5 e la seduta del P(1) con dolore 7, che conferma lo screening
 * con «Nessuna variazione». Sette contro cinque accende R2. Sulla seduta del P(1) il rinvio in
 * bozza con «Prepara rinvio»: motivo e urgenza dal promemoria R2 (peggioramento, programmato), poi il
 * destinatario Dott. Luca Ferri; niente assenso né consegna, così resta una bozza.
 */
async function seedValentina(tx: Tx, s: Seeded): Promise<void> {
  const [first, second] = doneExactly(s, 2);
  if (!first || !second) return;
  await seedFirstVisit(
    tx,
    s,
    first,
    { chiefComplaint: "Lombalgia dopo il parto", mainRegion: "lumbar", goal: "Prendere in braccio la bambina senza dolore" },
    [{ op: "campi", values: { nprsPre: 5 } }],
  );
  const visitId = await seedFollowUp(tx, second, [{ op: "campi", values: { nprsPre: 7 } }]);

  const clock = endClock(second);
  const { id: referralId } = await createReferral(tx, P, clock, { patientId: s.patientId, visitId });
  const letter = await getReferralLetter(tx, P, referralId);
  if (!letter) throw new Error("Il rinvio di Valentina non si rilegge.");
  await updateReferral(tx, P, clock, {
    referralId,
    recipientKind: "medico_curante",
    physicianId: await physicianNamed(tx, "Dott. Luca Ferri"),
    recipientFree: null,
    reason: letter.reason,
    urgency: letter.urgency,
    summaryText: letter.summaryText,
    requestText: letter.requestText,
    patientAgreedToShare: false,
  });
}

/** Le tre sedute di Davide: dolore a inizio seduta e lunge test in carico dx, 8 alla prima e 12 all'ultima. */
const DAVIDE_VISITS = [
  { pain: 5, lunge: 8, calf: 2 },
  { pain: 3, lunge: 10, calf: 1 },
  { pain: 1, lunge: 12, calf: 1 },
] as const;

/**
 * Davide: la prima visita del D0-90 apre il ciclo con le tre attività PSFS della demo e l'iniziale; le sedute
 * del D0-78 e del D0-66 confermano lo screening. Ogni visita ha la disfunzione del polpaccio dx, il lunge test e
 * i tessuti molli; l'ultima resta in bozza per i punteggi finali di `closeCycles` (ciclo "raggiunto").
 */
async function seedDavide(tx: Tx, s: Seeded): Promise<void> {
  const past = doneExactly(s, DAVIDE_VISITS.length);
  for (const [i, appointment] of past.entries()) {
    const values = DAVIDE_VISITS[i];
    if (!values) continue;
    const ops: VisitOp[] = [
      { op: "campi", values: { nprsPre: values.pain } },
      { op: "disfunzione", region: "lower_extremity", severity: values.calf, side: "dx" },
      { op: "test", testCode: "lunge_carico", side: "dx", valueNumeric: values.lunge },
      { op: "tecnica", region: "lower_extremity", techniqueCode: "tessuti_molli" },
    ];
    const last = i === past.length - 1;
    if (i === 0) {
      await seedFirstVisit(
        tx,
        s,
        appointment,
        { chiefComplaint: "Dolore al polpaccio destro nella corsa", mainRegion: "lower_extremity", goal: "Tornare a correre 30 minuti senza dolore" },
        ops,
        {
          psfs: [
            ["Correre 30 minuti", 3],
            ["Scendere le scale", 5],
            ["Saltare sul posto", 2],
          ],
        },
      );
    } else await seedFollowUp(tx, appointment, ops, last);
  }
}

/**
 * Chiara: gravidanza in corso a 27 settimane nello stile di vita e la voce dell'anamnesi con il tag
 * `gravidanza`, scritte prima della prima visita, così il gruppo "Gravidanza" dello screening si apre e si
 * conferma con "Nessun'altra voce". Due visite chiuse con ASLR dx 3 e 1 e due tecniche indirette (funzionale
 * lombare, tensione legamentosa bilanciata del bacino) sul fianco sinistro.
 */
async function seedChiara(tx: Tx, s: Seeded): Promise<void> {
  const past = doneExactly(s, 2);
  const [first] = past;
  if (!first) return;
  const historyClock = endClock(first);
  await saveLifestyle(tx, P, historyClock, {
    patientId: s.patientId,
    reviewedOn: first.day,
    occupation: null,
    sport: null,
    familyHistory: null,
    pregnancyStatus: "in_corso",
    pregnancyWeeks: 27,
  });
  await saveHistoryItem(tx, P, historyClock, {
    patientId: s.patientId,
    kind: "patologia",
    label: "Gravidanza in corso",
    region: null,
    occurredOn: null,
    occurredYear: null,
    ongoing: true,
    riskTags: ["gravidanza"],
    note: null,
  });

  const sideLying = "Sul fianco sinistro";
  const visits = [
    { pain: 6, aslr: 3, lumbar: 2, pelvic: 2 },
    { pain: 4, aslr: 1, lumbar: 1, pelvic: 1 },
  ] as const;
  for (const [i, appointment] of past.entries()) {
    const values = visits[i];
    if (!values) continue;
    const ops: VisitOp[] = [
      { op: "campi", values: { nprsPre: values.pain } },
      { op: "disfunzione", region: "lumbar", severity: values.lumbar },
      { op: "disfunzione", region: "pelvic", severity: values.pelvic },
      { op: "test", testCode: "aslr", side: "dx", valueOrdinal: values.aslr },
      { op: "tecnica", region: "lumbar", techniqueCode: "funzionale", note: sideLying },
      { op: "tecnica", region: "pelvic", techniqueCode: "blt", note: sideLying },
    ];
    if (i === 0) {
      await seedFirstVisit(
        tx,
        s,
        appointment,
        { chiefComplaint: "Lombalgia in gravidanza", mainRegion: "lumbar", goal: "Dormire tutta la notte senza dolore alla schiena" },
        ops,
        { groups: ["rf_gravidanza"] },
      );
    } else await seedFollowUp(tx, appointment, ops);
  }
}

/**
 * Giorgio: l'osteoporosi nell'anamnesi con il tag `osteoporosi` prima della prima visita, così
 * `ci_osteo` nasce "si" da anamnesi; due controlli chiusi con thrust e dirette "con cautela" e
 * indirette indicate (il suggerito di `ci_osteo`), funzionale dorsale e tessuti molli lombari, nessun thrust.
 */
async function seedGiorgio(tx: Tx, s: Seeded): Promise<void> {
  const past = doneExactly(s, 2);
  const [first] = past;
  if (!first) return;
  await saveHistoryItem(tx, P, endClock(first), {
    patientId: s.patientId,
    kind: "patologia",
    label: "Osteoporosi",
    region: null,
    occurredOn: null,
    occurredYear: null,
    ongoing: true,
    riskTags: ["osteoporosi"],
    note: null,
  });

  for (const [i, appointment] of past.entries()) {
    const clock = endClock(appointment);
    const { visitId } = await startVisit(tx, P, clock, { appointmentId: appointment.id });
    if (i === 0) await updateCycleOpening(tx, P, clock, { cycleId: s.cycleId, goal: "Mantenere la mobilità della schiena" });
    await edit(tx, clock, visitId, [
      { op: "campi", values: { nprsPre: 3 } },
      ...noOtherItem(ALWAYS_VISIBLE),
      {
        op: "esiti",
        outcomes: [
          { family: "thrust", outcome: "caution" },
          { family: "direct", outcome: "caution" },
          { family: "indirect", outcome: "indicated" },
        ],
      },
      { op: "disfunzione", region: "thoracic", severity: 2 },
      { op: "disfunzione", region: "lumbar", severity: 1 },
      { op: "tecnica", region: "thoracic", techniqueCode: "funzionale" },
      { op: "tecnica", region: "lumbar", techniqueCode: "tessuti_molli" },
    ]);
    await closeIt(tx, clock, visitId);
  }
}

/** Le tre sedute di Martina: dolore a inizio seduta e dita-pavimento, 20 alla prima e 12 all'ultima. */
const MARTINA_VISITS = [
  { pain: 4, fingerFloor: 20, lumbar: 2 },
  { pain: 3, fingerFloor: 16, lumbar: 1 },
  { pain: 2, fingerFloor: 12, lumbar: 1 },
] as const;

/** La madre presente a ogni seduta della minore, con il consenso alla presenza. */
const WITH_MOTHER = { othersPresent: "Madre", othersPresentConsented: true } as const;

/**
 * Martina: la prima visita del D0-89 apre il ciclo (Adams negativo, due attività PSFS con l'iniziale); le sedute
 * del D0-77 e del D0-65 confermano lo screening. Funzionale lombare a ogni seduta; l'ultima resta in bozza per i
 * punteggi finali di `closeCycles` (ciclo "parzialmente raggiunto").
 */
async function seedMartina(tx: Tx, s: Seeded): Promise<void> {
  const past = doneExactly(s, MARTINA_VISITS.length);
  for (const [i, appointment] of past.entries()) {
    const values = MARTINA_VISITS[i];
    if (!values) continue;
    const ops: VisitOp[] = [
      { op: "campi", values: { nprsPre: values.pain, ...WITH_MOTHER } },
      { op: "disfunzione", region: "lumbar", severity: values.lumbar },
      ...(i === 0 ? [{ op: "test", testCode: "adams", valueLateral: "neg" } as const] : []),
      { op: "test", testCode: "dita_pavimento", valueNumeric: values.fingerFloor },
      { op: "tecnica", region: "lumbar", techniqueCode: "funzionale" },
    ];
    if (i === 0) {
      await seedFirstVisit(
        tx,
        s,
        appointment,
        { chiefComplaint: "Mal di schiena dopo la ginnastica", mainRegion: "lumbar", goal: "Fare la lezione di ginnastica senza mal di schiena" },
        ops,
        {
          psfs: [
            ["Fare la lezione di ginnastica", 3],
            ["Portare lo zaino a scuola", 5],
          ],
        },
      );
    } else await seedFollowUp(tx, appointment, ops, i === past.length - 1);
  }
}

/** Lorenzo, prima visita del D0-10: Patrick (FABER) dx positivo con dolore, bacino severità 2, il padre presente. */
async function seedLorenzo(tx: Tx, s: Seeded): Promise<void> {
  const [first] = doneExactly(s, 1);
  if (!first) return;
  await seedFirstVisit(
    tx,
    s,
    first,
    {
      chiefComplaint: "Dolore all'inguine destro giocando a calcio",
      mainRegion: "pelvic",
      goal: "Giocare una partita intera senza dolore all'inguine",
    },
    [
      { op: "campi", values: { nprsPre: 5, othersPresent: "Padre", othersPresentConsented: true } },
      { op: "disfunzione", region: "pelvic", severity: 2 },
      { op: "test", testCode: "faber", side: "dx", valueBool: true, painProvoked: true },
      { op: "tecnica", region: "pelvic", techniqueCode: "energia_muscolare" },
    ],
  );
}

/** Paolo, prima visita del D0-20: cervicale severità 2, rotazione cervicale attiva, tessuti molli cervicali. */
async function seedPaolo(tx: Tx, s: Seeded): Promise<void> {
  const [first] = doneExactly(s, 1);
  if (!first) return;
  await seedFirstVisit(
    tx,
    s,
    first,
    { chiefComplaint: "Dolore cervicale", mainRegion: "cervical", goal: "Girare la testa guidando senza dolore" },
    [
      { op: "campi", values: { nprsPre: 5 } },
      { op: "disfunzione", region: "cervical", severity: 2 },
      { op: "test", testCode: "rom_rotazione_cervicale", side: "dx", valueNumeric: 55 },
      { op: "test", testCode: "rom_rotazione_cervicale", side: "sx", valueNumeric: 70 },
      { op: "tecnica", region: "cervical", techniqueCode: "tessuti_molli" },
    ],
  );
}

/**
 * Le cartelle della demo (visite passate tutte chiuse), dopo gli appuntamenti e i consensi e prima della chiusura
 * dei cicli: Roberto chiude "rinviato al medico" sul suo rinvio, e le ultime sedute di Davide e Martina restano in
 * bozza finché `closeCycles` non scrive i punteggi finali e le chiude. `clock` è l'orologio già congelato del
 * seed: D0 è il suo giorno e la bozza di Anna il suo istante.
 */
export async function seedClinical(tx: Tx, clock: Clock, seeded: readonly Seeded[]): Promise<void> {
  await seedMarco(tx, patientNamed(seeded, "Marco", "Bellandi"));
  await seedAnna(tx, clock, patientNamed(seeded, "Anna", "Morelli"));
  await seedRoberto(tx, patientNamed(seeded, "Roberto", "Esposito"));
  await seedGiulia(tx, patientNamed(seeded, "Giulia", "Ferrante"));
  await seedMatteo(tx, patientNamed(seeded, "Matteo", "Ricci"));
  await seedFrancesca(tx, patientNamed(seeded, "Francesca", "Longo"));
  await seedValentina(tx, patientNamed(seeded, "Valentina", "Greco"));
  await seedDavide(tx, patientNamed(seeded, "Davide", "Conti"));
  await seedChiara(tx, patientNamed(seeded, "Chiara", "Valli"));
  await seedGiorgio(tx, patientNamed(seeded, "Giorgio", "Sala"));
  await seedMartina(tx, patientNamed(seeded, "Martina", "De Luca"));
  await seedLorenzo(tx, patientNamed(seeded, "Lorenzo", "Gatti"));
  await seedPaolo(tx, patientNamed(seeded, "Paolo", "Neri"));
}
