/**
 * 企业档案主数据（company_profile）读取口径 —— 单一真相。
 *
 * 口径来源：docs/35-遗留项二轮收口设计（ERP 号段校验 + 三表单写路径 + 企业档案主数据 + 证书入口统一）.md §6
 *
 * 为什么要有这层：质量证书抬头 / 印章文字 / 「供货单位·产地」、制造证书抬头，历史上是模板里的
 * 硬编码常量（「宁波乐天紧固件制造有限公司」等）。常量即编造：企业信息一改、或系统换主体，
 * 证书仍会打印旧抬头。改为统一读 `company_profile` 单行主数据；**未维护即留白**，
 * 绝不回落到硬编码常量（缺失行为见 docs/35 §6「缺失行为」）。
 *
 * 缓存：模块级缓存一次。证书可能在台账里被逐行打开，避免每行一次请求。
 * 维护过企业档案后调用 `invalidateCompanyProfileCache()` 让下一次读取重新拉取。
 */
import { api } from './api';

/** 企业档案字段：全部可选，未维护即缺省（证书按空白渲染） */
export interface CompanyProfile {
  legalName?: string;
  legalNameEn?: string;
  shortName?: string;
  address?: string;
  originPlace?: string;
  phone?: string;
  email?: string;
  qualityStamp?: string;
  updatedBy?: string;
  updatedAt?: string;
}

/** undefined = 尚未加载；null = 已确认未维护 */
let cache: CompanyProfile | null | undefined;
let inflight: Promise<CompanyProfile | null> | null = null;

/**
 * 读取企业档案主数据。接口失败按「未维护」处理（证书留白 + 界面提示），
 * 不抛异常打断打印流程 —— 证书留白是可接受降级，编造抬头的代价不可接受。
 */
export async function loadCompanyProfile(force = false): Promise<CompanyProfile | null> {
  if (!force) {
    if (cache !== undefined) return cache;
    if (inflight !== null) return inflight;
  }
  const request = api
    .get<CompanyProfile | null>('/master-data/company-profile')
    .then(
      (profile) => {
        cache = profile ?? null;
        inflight = null;
        return cache;
      },
      () => {
        cache = null;
        inflight = null;
        return null;
      }
    );
  inflight = request;
  return request;
}

/** 企业档案保存成功后失效缓存：下一次读取即拿到新值 */
export function invalidateCompanyProfileCache(): void {
  cache = undefined;
  inflight = null;
}

/** 取第一个非空字段并去空白；全空即空串（证书字段一律不编造默认值） */
export function profileText(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    const text = (value ?? '').trim();
    if (text !== '') return text;
  }
  return '';
}

/** 企业档案是否已维护（证书是否有抬头可打印） */
export function isCompanyProfileMaintained(profile: CompanyProfile | null | undefined): boolean {
  return profileText(profile?.legalName) !== '';
}