/** La domanda riguarda un singolo appuntamento completo, senza una scelta già confermata. */
export function needsPastQuestion(input: {
  complete: boolean;
  bornDone: boolean;
  repeat: boolean;
  pastStart: boolean;
  confirmedChoice: boolean;
}): boolean {
  return input.complete && !input.bornDone && !input.repeat && input.pastStart && !input.confirmedChoice;
}
