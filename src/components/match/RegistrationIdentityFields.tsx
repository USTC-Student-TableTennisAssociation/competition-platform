/** Uncontrolled, blank fields: never preload a saved name or ID into the page. */
export default function RegistrationIdentityFields() {
  return (
    <fieldset className="space-y-3 rounded-xl border border-white/10 p-4 text-sm">
      <legend className="px-1 font-semibold text-slate-100">本人身份信息</legend>
      <p className="text-xs leading-5 text-slate-300">
        本场比赛需要核验参赛者身份。请填写本人的证件信息，仅供本站管理员办理本场比赛报名使用，不会在参赛名单中公开。
      </p>
      <label className="block space-y-1 text-slate-200">
        <span>真实姓名</span>
        <input
          name="realName"
          type="text"
          placeholder="与身份证上的姓名一致"
          maxLength={80}
          autoComplete="off"
          required
          className="input-dark min-h-11 w-full rounded-xl px-3 py-2"
        />
      </label>
      <label className="block space-y-1 text-slate-200">
        <span>身份证号</span>
        <input
          name="idNumber"
          type="text"
          placeholder="18 位居民身份证号码"
          pattern="[0-9]{17}[0-9Xx]"
          title="请输入 18 位居民身份证号码，末位可以是 X"
          maxLength={18}
          autoComplete="off"
          spellCheck={false}
          required
          className="input-dark min-h-11 w-full rounded-xl px-3 py-2"
        />
      </label>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-200">
        <input name="identityConsent" type="checkbox" required className="mt-1" />
        <span>我同意本站为本场比赛报名收集并使用本人的姓名和身份证号。</span>
      </label>
    </fieldset>
  );
}
