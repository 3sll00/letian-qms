/**
 * 企业档案（company_profile 单行主数据）维护视图 —— docs/35 §6。
 *
 * 为什么要有这一页：质量证书抬头 / 印章文字 / 「供货单位·产地」、制造证书抬头，此前是模板里的
 * 硬编码常量。改为读 `company_profile` 主数据后，必须有人能维护它，否则证书抬头只能留白。
 * 口径：
 *   - 读取 `GET /master-data/company-profile`（无行返回 null = 未维护，界面显式提示）；
 *   - 保存 `PUT /master-data/company-profile`（服务端 upsert，`updated_by` 取当前登录用户）；
 *   - 邮箱受契约 `z.string().email()` 约束，**留空即不下发该字段**（不能用空串清空，否则 400）；
 *     其余字段留空即清空（服务端以「显式字段才更新」为准）。
 */
import React, { useEffect, useState } from 'react';
import { Building2, CheckCircle2, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { invalidateCompanyProfileCache, type CompanyProfile } from '../../lib/companyProfile';

/** 表单字段定义：label + 该字段在证书上的落点说明（改这里即改界面，不需要动渲染逻辑） */
const FIELDS: readonly { key: keyof CompanyProfile; label: string; hint: string }[] = [
  { key: 'legalName', label: '企业法定名称（证书抬头 · 中文）', hint: '质量 / 制造证书抬头第一行' },
  { key: 'legalNameEn', label: '企业英文名称（证书抬头 · 英文）', hint: '证书英文抬头与页脚' },
  { key: 'shortName', label: '企业简称', hint: '界面展示用' },
  { key: 'address', label: '企业地址（中文）', hint: '对外证书地址栏' },
  { key: 'originPlace', label: '产地', hint: '质量证书「供货单位/产地」单元格' },
  { key: 'phone', label: '联系电话', hint: '对外联系信息' },
  { key: 'email', label: '电子邮箱', hint: '对外联系信息（须为合法邮箱，留空即不下发）' },
  { key: 'qualityStamp', label: '证书印章文字', hint: '质量证书印章圆章内文字' },
];

type ProfileForm = Record<string, string>;

const EMPTY_FORM: ProfileForm = FIELDS.reduce<ProfileForm>((acc, field) => {
  acc[field.key as string] = '';
  return acc;
}, {});

function toForm(profile: CompanyProfile | null): ProfileForm {
  const form: ProfileForm = { ...EMPTY_FORM };
  if (profile === null) return form;
  for (const field of FIELDS) {
    const value = profile[field.key];
    form[field.key as string] = value === undefined || value === null ? '' : String(value);
  }
  return form;
}

export function CompanyProfileView({ refreshKey }: { refreshKey?: number }) {
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [maintained, setMaintained] = useState<boolean>(false);
  const [updatedBy, setUpdatedBy] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const profile = await api.get<CompanyProfile | null>('/master-data/company-profile');
        if (cancelled) return;
        setForm(toForm(profile));
        setMaintained(profile !== null && (profile.legalName ?? '') !== '');
        setUpdatedBy(profile?.updatedBy !== undefined && profile?.updatedBy !== null ? String(profile.updatedBy) : '');
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setReceipt(null);
    try {
      const payload: Record<string, string> = {};
      for (const field of FIELDS) {
        const value = (form[field.key as string] ?? '').trim();
        // 邮箱留空不下发：契约是 z.string().email()，空串会被判非法（其余字段空串=清空）
        if (field.key === 'email' && value === '') continue;
        payload[field.key as string] = value;
      }
      const saved = await api.put<CompanyProfile>('/master-data/company-profile', payload);
      setForm(toForm(saved));
      setMaintained((saved.legalName ?? '') !== '');
      setUpdatedBy(saved.updatedBy !== undefined && saved.updatedBy !== null ? String(saved.updatedBy) : '');
      // 企业档案已变：失效证书读取侧的模块级缓存，之后生成的证书立即用新抬头
      invalidateCompanyProfileCache();
      setReceipt('企业档案已保存；此后生成的证书将使用新抬头 / 印章。');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-blue-600" /> 企业档案
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            证书抬头 / 印章 / 供货单位·产地的唯一数据源；未维护时证书对应单元格留白（不回落模板里的硬编码抬头）。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || loading}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shadow-sm disabled:opacity-50 shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
          {saving ? '保存中…' : '保存企业档案'}
        </button>
      </div>

      {!maintained && !loading && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          企业档案未维护：当前证书抬头与印章为空白。请至少填写「企业法定名称」，再生成对外证书。
        </div>
      )}
      {error !== null && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">
          企业档案操作失败：<span className="font-mono">{error}</span>
        </div>
      )}
      {receipt !== null && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{receipt}</span>
        </div>
      )}

      <div className="bg-white border border-slate-200/80 rounded-lg shadow-sm p-4">
        {loading ? (
          <div className="py-16 text-center text-xs text-slate-400">企业档案加载中…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {FIELDS.map((field) => (
              <div key={field.key as string}>
                <label className="block text-slate-600 font-medium mb-1">{field.label}</label>
                <input
                  type="text"
                  value={form[field.key as string] ?? ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field.key as string]: e.target.value }))}
                  placeholder={field.key === 'legalName' ? '如：宁波乐天紧固件制造有限公司' : '未维护即留空'}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-500"
                />
                <p className="text-[11px] text-slate-400 mt-1">{field.hint}</p>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 pt-3 border-t border-slate-100 text-[11px] text-slate-400">
          最后维护人：{updatedBy !== '' ? updatedBy : '—'}（保存时由服务端按当前登录用户写入）
        </div>
      </div>
    </div>
  );
}