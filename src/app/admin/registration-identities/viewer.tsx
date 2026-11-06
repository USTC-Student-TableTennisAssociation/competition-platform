'use client'

import { useActionState, useState } from 'react'
import { revealIdentity } from './actions'

export function IdentityViewer({matchId, members}: {matchId: string; members: Array<{id: string; nickname: string}>}) {
  const [selected, select] = useState('')
  const [generation, clear] = useState(0)
  return <div className="space-y-4">
    <label className="grid gap-1">参赛者<select className="rounded-lg border border-slate-600 bg-slate-900 p-2" value={selected} onChange={e => select(e.target.value)}>
      <option value="">选择参赛者</option>{members.map(m => <option key={m.id} value={m.id}>{m.nickname} · {m.id.slice(-6)}</option>)}
    </select></label>
    {selected && <Reveal key={selected + ':' + generation} userId={selected} matchId={matchId} hide={() => clear(n => n + 1)} />}
  </div>
}

function Reveal({matchId,userId,hide}: {matchId:string;userId:string;hide:()=>void}) {
  const [state, action, pending] = useActionState(revealIdentity, {})
  return <form action={action} className="space-y-4">
    <input type="hidden" name="matchId" value={matchId}/><input type="hidden" name="userId" value={userId}/>
    <input type="hidden" name="csrfToken" value="" readOnly/>
    {state.details ? <><dl className="grid gap-1"><dt>真实姓名</dt><dd>{state.details.realName}</dd><dt>居民身份证号</dt><dd className="font-mono">{state.details.idNumber}</dd></dl>
      <button type="button" onClick={hide} className="btn-secondary rounded-lg px-4 py-2">收起资料</button></> :
      <button type="submit" disabled={pending} className="btn-secondary rounded-lg px-4 py-2">{pending ? '读取中…' : '查看本人提交的身份资料'}</button>}
    {state.error && <p role="alert">{state.error}</p>}
  </form>
}
