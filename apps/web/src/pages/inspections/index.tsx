import React, { useState, useEffect } from 'react';
import { IqcList } from './components/IqcList';
import { IqcRecordForm } from './components/IqcRecordForm';
import { IpqcViews } from './components/IpqcViews';
import { OutsourceList } from './components/OutsourceList';
import { OutsourceInspectionForm } from './components/OutsourceInspectionForm';
import { OqcList } from './components/OqcList';
import { OqcRecordForm } from './components/OqcRecordForm';
import { CertTemplatePickerModal } from '../../components/certificate/CertTemplatePickerModal';
import type { CertTemplateKind } from '../../lib/inspectionTypes';

interface InspectionsPageProps {
  initialStage?: 'iqc' | 'ipqc' | 'outsource' | 'oqc';
  activeTab?: 'iqc' | 'ipqc' | 'outsource' | 'oqc';
}

export function InspectionsPage({ initialStage, activeTab }: InspectionsPageProps) {
  const effectiveStage = activeTab || initialStage || 'iqc';
  const [stage, setStage] = useState<'iqc' | 'ipqc' | 'outsource' | 'oqc'>(effectiveStage);
  const [ipqcSub, setIpqcSub] = useState<'overview' | 'blanking' | 'rolling' | 'finished'>('overview');

  const [activeIqcRecord, setActiveIqcRecord] = useState<any | null>(null);
  const [isIqcReadOnly, setIsIqcReadOnly] = useState<boolean>(false);
  const [activeOqcRecord, setActiveOqcRecord] = useState<any | null>(null);
  // 出货检验回看标记：列表行状态已是「已合格 / 不合格」时打开的是历史单据，必须走本单方案快照
  const [isOqcReadOnly, setIsOqcReadOnly] = useState<boolean>(false);
  const [activeOutsourceRecord, setActiveOutsourceRecord] = useState<any | null>(null);
  // 委外检验回看标记：已判定的委外单打开的是历史单据，必须走本单方案快照（TBD-07）
  const [isOutsourceReadOnly, setIsOutsourceReadOnly] = useState<boolean>(false);

  /**
   * 证书模板选择（docs/51）：操作员「填写检验内容前」先选版式，所选值随单落 `cert_template`。
   * 规则：进入**可编辑**录入且该单尚无 certTemplate 时先弹选择器；只读回看与已选过模板的单
   * 一律直进表单（历史单按其建单时选定的版式出证，不重复打扰）。
   */
  const [pickerCtx, setPickerCtx] = useState<{
    target: 'iqc' | 'oqc' | 'outsource';
    item: any;
  } | null>(null);

  /**
   * 证书模板选择（docs/51）收窄：只有「委外检验-表面检验」需要操作员在 QUALITY / MANUFACTURING 间选版式；
   * 其余类型（IQC / OQC出货 / IPQC / 委外机加工 / 委外热处理）不弹选择框，直接按各自唯一适用的模板出证：
   *   IQC / OQC出货 / IPQC -> QUALITY（质保书）；委外机加工 / 委外热处理 -> MANUFACTURING（制造证书）。
   * 各录入表单在 initialItem.certTemplate 缺失时已有正确缺省（见各表单 useState 初值），跳过选择框不会落错版式。
   */
  const openWithCertTemplate = (
    target: 'iqc' | 'oqc' | 'outsource',
    item: any,
    readOnly: boolean,
    opts?: { isSurface?: boolean }
  ) => {
    // 仅「委外检验-表面检验」且本单尚未选定模板时，才弹选择框让操作员选版式
    const allowPicker =
      target === 'outsource' && opts?.isSurface === true && item?.certTemplate === undefined;
    if (readOnly || !allowPicker) {
      if (target === 'iqc') {
        setActiveIqcRecord(item);
        setIsIqcReadOnly(readOnly);
      } else if (target === 'oqc') {
        setActiveOqcRecord(item);
        setIsOqcReadOnly(readOnly);
      } else {
        setActiveOutsourceRecord(item);
        setIsOutsourceReadOnly(readOnly);
      }
      return;
    }
    setPickerCtx({ target, item });
  };

  const handlePickerConfirm = (kind: CertTemplateKind) => {
    const ctx = pickerCtx;
    setPickerCtx(null);
    if (!ctx) return;
    const record = { ...ctx.item, certTemplate: kind };
    if (ctx.target === 'iqc') {
      setActiveIqcRecord(record);
      setIsIqcReadOnly(false);
    } else if (ctx.target === 'oqc') {
      setActiveOqcRecord(record);
      setIsOqcReadOnly(false);
    } else {
      setActiveOutsourceRecord(record);
      setIsOutsourceReadOnly(false);
    }
  };

  const pickerRecommended: CertTemplateKind =
    pickerCtx?.target === 'outsource' ? 'MANUFACTURING' : 'QUALITY';

  useEffect(() => {
    const next = activeTab || initialStage || 'iqc';
    setStage(next);
    if (next === 'ipqc') setIpqcSub('overview');
    setActiveIqcRecord(null);
    setActiveOqcRecord(null);
    setIsOqcReadOnly(false);
    setActiveOutsourceRecord(null);
    setIsOutsourceReadOnly(false);
  }, [initialStage, activeTab]);

  // If in IQC recording mode (对应 质量保证证书.pdf 样式)
  if (activeIqcRecord) {
    return (
      <IqcRecordForm
        initialItem={activeIqcRecord}
        readOnly={isIqcReadOnly}
        onBack={() => {
          setActiveIqcRecord(null);
          setIsIqcReadOnly(false);
        }}
        // 写路径已由来料表单自身落实并回执服务端单号（docs/35 §4 M3），此处只做「返回列表」的状态复位：
        // 不再用 alert 重复一次系统没有校验过的「已保存提交」
        onSubmit={() => {
          setActiveIqcRecord(null);
          setIsIqcReadOnly(false);
        }}
      />
    );
  }

  // If in Outsource recording mode (对应 MANUFACTURING CERT.pdf 样式)
  if (activeOutsourceRecord) {
    return (
      <OutsourceInspectionForm
        initialItem={activeOutsourceRecord}
        readOnly={isOutsourceReadOnly}
        onBack={() => {
          setActiveOutsourceRecord(null);
          setIsOutsourceReadOnly(false);
        }}
        // 写路径已由委外表单自身落实并回执服务端单号（docs/34 §6.2），此处只做「返回列表」的状态复位：
        // 不再用 alert 重复一次系统没有校验过的「已保存提交」
        onSubmit={() => {
          setActiveOutsourceRecord(null);
          setIsOutsourceReadOnly(false);
        }}
      />
    );
  }

  // If in OQC recording mode (对应 质量保证证书.pdf 样式)
  if (activeOqcRecord) {
    return (
      <OqcRecordForm
        initialItem={activeOqcRecord}
        readOnly={isOqcReadOnly}
        onBack={() => {
          setActiveOqcRecord(null);
          setIsOqcReadOnly(false);
        }}
        // 写路径已由出货表单自身落实并回执服务端单号（docs/35 §4 M3），此处只做状态复位，不再 alert
        onSubmit={() => {
          setActiveOqcRecord(null);
          setIsOqcReadOnly(false);
        }}
      />
    );
  }

  // If in IPQC (过程检验)
  if (stage === 'ipqc') {
    return (
      <IpqcViews
        sub={ipqcSub}
        onChangeSub={(s) => setIpqcSub(s)}
        onInspect={(item) => setActiveIqcRecord(item)}
      />
    );
  }

  const picker = (
    <CertTemplatePickerModal
      isOpen={pickerCtx !== null}
      recommended={pickerRecommended}
      onConfirm={handlePickerConfirm}
      onCancel={() => setPickerCtx(null)}
    />
  );

  // If in Outsource (委外检验)
  if (stage === 'outsource') {
    return (
      <>
        <OutsourceList
          onInspect={(item, readOnly, isSurface) =>
            openWithCertTemplate('outsource', item, readOnly === true, { isSurface })
          }
        />
        {picker}
      </>
    );
  }

  // If in OQC 出货检验列表 (WPS图片(9))
  if (stage === 'oqc') {
    return (
      <>
        <OqcList
          onInspect={(item) => {
            // OqcList 已在行上给出 isReadOnly（已合格 / 不合格 → 只读回看）
            openWithCertTemplate('oqc', item, item?.isReadOnly === true);
          }}
          onNew={() => {
            // 新建出货检验单：OQC 出货只出质保书（QUALITY），不弹模板选择框（docs/51 收窄）；
            // 单号仍由服务端取号，直接进录入表单按缺省 QUALITY 版式出证
            setActiveOqcRecord({ certTemplate: 'QUALITY' });
            setIsOqcReadOnly(false);
          }}
        />
        {picker}
      </>
    );
  }

  // Default: IQC 来料检验列表 (WPS图片(2))
  return (
    <>
      <IqcList
        onInspect={(item, readOnly) => {
          // 列表「详情」按钮 = 只读回看（走本单方案快照）；「检验 / 继续」= 按当前方案录入；
          // 可编辑且无模板记录时先弹模板选择（docs/51）
          openWithCertTemplate('iqc', item, readOnly === true);
        }}
      />
      {picker}
    </>
  );
}
