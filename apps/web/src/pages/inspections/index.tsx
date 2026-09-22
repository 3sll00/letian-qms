import React, { useState, useEffect } from 'react';
import { IqcList } from './components/IqcList';
import { IqcRecordForm } from './components/IqcRecordForm';
import { IpqcViews } from './components/IpqcViews';
import { OutsourceList } from './components/OutsourceList';
import { OutsourceInspectionForm } from './components/OutsourceInspectionForm';
import { OqcList } from './components/OqcList';
import { OqcRecordForm } from './components/OqcRecordForm';

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

  // If in Outsource (委外检验)
  if (stage === 'outsource') {
    return (
      <OutsourceList
        onInspect={(item, readOnly) => {
          setActiveOutsourceRecord(item);
          setIsOutsourceReadOnly(readOnly === true);
        }}
      />
    );
  }

  // If in OQC 出货检验列表 (WPS图片(9))
  if (stage === 'oqc') {
    return (
      <OqcList
        onInspect={(item) => {
          setActiveOqcRecord(item);
          // OqcList 已在行上给出 isReadOnly（已合格 / 不合格 → 只读回看）
          setIsOqcReadOnly(item?.isReadOnly === true);
        }}
        onNew={() => {
          // 新建出货检验单：不带任何演示单号 —— 检验单号由服务端按规则取号（docs/33 §2.1 口径）
          setActiveOqcRecord({});
          setIsOqcReadOnly(false);
        }}
      />
    );
  }

  // Default: IQC 来料检验列表 (WPS图片(2))
  return (
    <IqcList
      onInspect={(item, readOnly) => {
        // 列表「详情」按钮 = 只读回看（走本单方案快照）；「检验 / 继续」= 按当前方案录入
        setActiveIqcRecord(item);
        setIsIqcReadOnly(readOnly === true);
      }}
    />
  );
}
