import { RegistrationIdentityError, type RegistrationIdentityInput } from "../../../lib/server/registration-identity";

/** Never return form values in validation errors, logs or action state. */
export function readRegistrationIdentity(form: FormData): RegistrationIdentityInput | undefined {
  const fields = ["realName", "idNumber", "identityConsent"] as const;
  if (fields.every(field => !form.has(field))) return undefined;
  const values = fields.map(field => form.getAll(field));
  if (values.some(v => v.length !== 1 || typeof v[0] !== "string")) {
    throw new RegistrationIdentityError("请完整填写本人姓名、身份证号，并确认同意本场比赛收集这些信息。");
  }
  return { realName: values[0][0] as string, idNumber: values[1][0] as string, consent: values[2][0] === "on" };
}
