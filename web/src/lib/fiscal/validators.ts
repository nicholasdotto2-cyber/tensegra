import { taxCodeProblem } from "@/lib/patients/tax-code";

export const VAT_INVALID = "La partita IVA non è valida: controlla le cifre";
export const TAX_CODE_INVALID = "Il codice fiscale non è valido: controlla lettere e cifre.";
export const IBAN_INVALID = "L'IBAN non è valido: controlla le cifre.";

export function vatNumberProblem(v: string): string | null {
  if (!/^\d{11}$/.test(v)) return VAT_INVALID;
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    let digit = Number(v.charAt(index));
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - sum % 10) % 10 === Number(v.charAt(10)) ? null : VAT_INVALID;
}

export function fiscalCodeProblem(v: string): string | null {
  if (v.length === 16) return taxCodeProblem(v);
  return vatNumberProblem(v) === null ? null : TAX_CODE_INVALID;
}

export function ibanProblem(v: string): string | null {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(v)) return IBAN_INVALID;
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    if (character >= "A" && character <= "Z") {
      remainder = (remainder * 100 + character.charCodeAt(0) - 55) % 97;
    } else {
      remainder = (remainder * 10 + Number(character)) % 97;
    }
  }
  return remainder === 1 ? null : IBAN_INVALID;
}

export function isPostalCode(v: string): boolean {
  return /^\d{5}$/.test(v);
}

export function isProvince(v: string): boolean {
  return /^[A-Z]{2}$/.test(v);
}
