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
  const [activeOutsourceRecord, setActiveOutsourceRecord] = useState<any | null>(null);

  useEffect(() => {
    const next = activeTab || initialStage || 'iqc';
    setStage(next);
    if (next === 'ipqc') setIpqcSub('overview');
    setActiveIqcRecord(null);
    setActiveOqcRecord(null);
    setActiveOutsourceRecord(null);
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
        onSubmit={(res) => {
          alert('来料检验单已保存提交！');
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
        onBack={() => setActiveOutsourceRecord(null)}
        onSubmit={(res) => {
          alert('委外检验单已保存提交！');
          setActiveOutsourceRecord(null);
        }}
      />
    );
  }

  // If in OQC recording mode (对应 质量保证证书.pdf 样式)
  if (activeOqcRecord) {
    return (
      <OqcRecordForm
        initialItem={activeOqcRecord}
        onBack={() => setActiveOqcRecord(null)}
        onSubmit={(res) => {
          alert('出货检验单已提交完成！');
          setActiveOqcRecord(null);
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
        onInspect={(item) => setActiveOutsourceRecord(item)}
      />
    );
  }

  // If in OQC 出货检验列表 (WPS图片(9))
  if (stage === 'oqc') {
    return (
      <OqcList
        onInspect={(item) => setActiveOqcRecord(item)}
        onNew={() => setActiveOqcRecord({ docNo: 'OQC-XS-2022-03-05-00002' })}
      />
    );
  }

  // Default: IQC 来料检验列表 (WPS图片(2))
  return (
    <IqcList
      onInspect={(item) => setActiveIqcRecord(item)}
    />
  );
}
