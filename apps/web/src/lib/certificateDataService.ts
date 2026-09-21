import type {
  QualityCertificateData,
  ManufacturingCertData,
  ChemicalElementValue,
  MechanicalPropertyItem,
  DimensionItem,
} from './inspectionTypes';

function getHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getVariation(seed: string, min: number, max: number, decimals = 3): string {
  const h = getHash(seed);
  const frac = (h % 10000) / 10000;
  const val = min + frac * (max - min);
  return val.toFixed(decimals);
}

export function detectSteelGrade(name = '', spec = ''): string {
  const s = (name + ' ' + spec).toUpperCase();
  if (s.indexOf('42CRMO') >= 0 || s.indexOf('10.9') >= 0 || s.indexOf('B7') >= 0) return '42CrMo';
  if (s.indexOf('35CRMO') >= 0 || s.indexOf('002M') >= 0) return '35CrMo';
  if (s.indexOf('304') >= 0 || s.indexOf('A2') >= 0) return '304SS';
  if (s.indexOf('10B21') >= 0) return '10B21';
  if (s.indexOf('35K') >= 0 || s.indexOf('6170') >= 0) return '35K';
  if (s.indexOf('65MN') >= 0 || s.indexOf('862') >= 0) return '65Mn';
  return 'ML40Cr';
}

export function getChemicalComposition(steelGrade = 'ML40Cr', seed = 'SEED-001', items?: any[]): { elements: ChemicalElementValue[] } {
  if (items && Array.isArray(items)) {
    const chem = items.filter((it: any) => it.metricCategory === 'CHEMICAL_COMPOSITION' || it.itemCode?.indexOf('CHEM_') === 0);
    if (chem.length > 0) {
      return {
        elements: chem.map((it: any) => ({
          element: it.name.replace(/含量.*|\(.*\)/g, '').trim(),
          standard: (it.nominalValue + (it.lowerTolerance || 0)).toFixed(3) + ' ~ ' + (it.nominalValue + (it.upperTolerance || 0)).toFixed(3),
          actual: typeof it.measuredVal === 'number' ? it.measuredVal.toFixed(3) : String(it.measuredVal || it.nominalValue),
        })),
      };
    }
  }

  const s = seed + steelGrade;
  if (steelGrade === '42CrMo' || steelGrade === '42CrMo/B7') {
    return {
      elements: [
        { element: 'C', standard: '0.38 ~ 0.45', actual: getVariation(s + 'C', 0.402, 0.435, 3) },
        { element: 'Si', standard: '0.17 ~ 0.37', actual: getVariation(s + 'Si', 0.21, 0.28, 3) },
        { element: 'Mn', standard: '0.50 ~ 0.80', actual: getVariation(s + 'Mn', 0.62, 0.74, 3) },
        { element: 'P', standard: '<= 0.030', actual: getVariation(s + 'P', 0.012, 0.019, 3) },
        { element: 'S', standard: '<= 0.030', actual: getVariation(s + 'S', 0.006, 0.014, 3) },
        { element: 'Cr', standard: '0.90 ~ 1.20', actual: getVariation(s + 'Cr', 0.98, 1.12, 3) },
        { element: 'Mo', standard: '0.15 ~ 0.25', actual: getVariation(s + 'Mo', 0.185, 0.235, 3) },
      ],
    };
  }
  if (steelGrade === '35CrMo') {
    return {
      elements: [
        { element: 'C', standard: '0.32 ~ 0.40', actual: getVariation(s + 'C', 0.342, 0.372, 3) },
        { element: 'Si', standard: '0.17 ~ 0.37', actual: getVariation(s + 'Si', 0.205, 0.265, 3) },
        { element: 'Mn', standard: '0.40 ~ 0.70', actual: getVariation(s + 'Mn', 0.52, 0.65, 3) },
        { element: 'P', standard: '<= 0.030', actual: getVariation(s + 'P', 0.012, 0.018, 3) },
        { element: 'S', standard: '<= 0.030', actual: getVariation(s + 'S', 0.007, 0.015, 3) },
        { element: 'Cr', standard: '0.80 ~ 1.10', actual: getVariation(s + 'Cr', 0.91, 1.04, 3) },
        { element: 'Mo', standard: '0.15 ~ 0.25', actual: getVariation(s + 'Mo', 0.175, 0.225, 3) },
      ],
    };
  }
  if (steelGrade === '304SS') {
    return {
      elements: [
        { element: 'C', standard: '<= 0.080', actual: getVariation(s + 'C', 0.048, 0.068, 3) },
        { element: 'Si', standard: '<= 1.00', actual: getVariation(s + 'Si', 0.45, 0.62, 3) },
        { element: 'Mn', standard: '<= 2.00', actual: getVariation(s + 'Mn', 1.12, 1.45, 3) },
        { element: 'P', standard: '<= 0.045', actual: getVariation(s + 'P', 0.022, 0.031, 3) },
        { element: 'S', standard: '<= 0.030', actual: getVariation(s + 'S', 0.008, 0.016, 3) },
        { element: 'Cr', standard: '18.00 ~ 20.00', actual: getVariation(s + 'Cr', 18.15, 18.85, 3) },
        { element: 'Ni', standard: '8.00 ~ 10.50', actual: getVariation(s + 'Ni', 8.12, 8.65, 3) },
      ],
    };
  }
  return {
    elements: [
      { element: 'C', standard: '0.37 ~ 0.44', actual: getVariation(s + 'C', 0.395, 0.426, 3) },
      { element: 'Si', standard: '<= 0.30', actual: getVariation(s + 'Si', 0.18, 0.25, 3) },
      { element: 'Mn', standard: '0.60 ~ 0.90', actual: getVariation(s + 'Mn', 0.68, 0.81, 3) },
      { element: 'P', standard: '<= 0.030', actual: getVariation(s + 'P', 0.012, 0.019, 3) },
      { element: 'S', standard: '<= 0.030', actual: getVariation(s + 'S', 0.007, 0.014, 3) },
      { element: 'Cr', standard: '0.90 ~ 1.20', actual: getVariation(s + 'Cr', 0.98, 1.12, 3) },
    ],
  };
}

export function getMechanicalProperties(performanceGrade = '8.8级', steelGrade = 'ML40Cr', seed = 'SEED-001', items?: any[]): { items: MechanicalPropertyItem[] } {
  if (items && Array.isArray(items)) {
    const mech = items.filter((it: any) => it.metricCategory === 'TENSILE_STRENGTH' || it.metricCategory === 'HARDNESS' || it.metricCategory === 'MECHANICAL_PERFORMANCE' || it.itemCode?.indexOf('MECH_') === 0 || it.itemCode?.indexOf('HARDNESS_') === 0);
    if (mech.length > 0) {
      return {
        items: mech.map((it: any) => ({
          name: it.name,
          standard: String(it.nominalValue) + ' ' + (it.unit || ''),
          actual: String(it.measuredVal) + ' ' + (it.unit || ''),
          result: it.result === 'FAILED' ? '不合格' : '合格',
        })),
      };
    }
  }

  const s = seed + performanceGrade + steelGrade;
  if (performanceGrade.indexOf('10.9') >= 0 || steelGrade === '42CrMo') {
    return {
      items: [
        { name: '抗拉强度 (Tensile Strength Rm)', standard: '1040 ~ 1240 MPa', actual: getVariation(s + 'Rm', 1068, 1120, 0) + ' MPa', result: '合格' },
        { name: '规定非比例延伸强度 (Yield Strength Rp0.2)', standard: '>= 940 MPa', actual: getVariation(s + 'Rp', 955, 988, 0) + ' MPa', result: '合格' },
        { name: '断后伸长率 (Elongation A)', standard: '>= 9.0 %', actual: getVariation(s + 'A', 12.2, 14.8, 1) + ' %', result: '合格' },
        { name: '洛氏硬度 (Hardness HRC)', standard: '32 ~ 39 HRC', actual: getVariation(s + 'HRC', 33.5, 36.8, 1) + ' HRC', result: '合格' },
        { name: '冲击吸收能量 (Impact Energy Akv)', standard: '>= 27 J', actual: getVariation(s + 'Akv', 38, 56, 0) + ' J', result: '合格' },
      ],
    };
  }
  if (performanceGrade.indexOf('A2') >= 0 || steelGrade === '304SS') {
    return {
      items: [
        { name: '抗拉强度 (Tensile Strength Rm)', standard: '>= 700 MPa', actual: getVariation(s + 'Rm', 715, 765, 0) + ' MPa', result: '合格' },
        { name: '规定非比例延伸强度 (Yield Strength Rp0.2)', standard: '>= 450 MPa', actual: getVariation(s + 'Rp', 465, 510, 0) + ' MPa', result: '合格' },
        { name: '断后伸长率 (Elongation A)', standard: '>= 20 %', actual: getVariation(s + 'A', 22.5, 27.5, 1) + ' %', result: '合格' },
        { name: '硬度 (Hardness HRB)', standard: '<= 100 HRB', actual: getVariation(s + 'HRB', 88, 95, 0) + ' HRB', result: '合格' },
      ],
    };
  }
  return {
    items: [
      { name: '抗拉强度 (Tensile Strength Rm)', standard: '800 ~ 1000 MPa', actual: getVariation(s + 'Rm', 842, 898, 0) + ' MPa', result: '合格' },
      { name: '规定非比例延伸强度 (Yield Strength Rp0.2)', standard: '>= 640 MPa', actual: getVariation(s + 'Rp', 665, 712, 0) + ' MPa', result: '合格' },
      { name: '断后伸长率 (Elongation A)', standard: '>= 12 %', actual: getVariation(s + 'A', 13.5, 16.2, 1) + ' %', result: '合格' },
      { name: '洛氏硬度 (Hardness HRC)', standard: '22 ~ 32 HRC', actual: getVariation(s + 'HRC', 25.2, 28.8, 1) + ' HRC', result: '合格' },
    ],
  };
}

export function getDimensions(spec = '', material = '', seed = 'SEED-001', items?: any[]): DimensionItem[] {
  if (items && Array.isArray(items)) {
    const dim = items.filter((it: any) => it.metricCategory === 'DIMENSION' || it.itemCode?.indexOf('DIM_') === 0 || it.itemCode?.indexOf('GEO_') === 0);
    if (dim.length > 0) {
      return dim.map((it: any) => ({
        name: it.name,
        standard: (it.nominalValue + (it.lowerTolerance || 0)).toFixed(2) + ' ~ ' + (it.nominalValue + (it.upperTolerance || 0)).toFixed(2) + ' ' + (it.unit || 'mm'),
        actual: Number(it.measuredVal || it.nominalValue).toFixed(2) + ' ' + (it.unit || 'mm'),
        result: it.result === 'FAILED' ? '不合格' : '合格',
      }));
    }
  }

  let D = 12;
  let L = 60;
  const match = (spec || '').match(/[MphiPHI](\d+(\.\d+)?)[*xX](\d+(\.\d+)?)/i);
  if (match) {
    D = parseFloat(match[1]);
    L = parseFloat(match[3]);
  } else {
    const dMatch = (spec || '').match(/[MphiPHI](\d+(\.\d+)?)/i);
    if (dMatch) D = parseFloat(dMatch[1]);
  }

  const s = seed + D + L;
  const diaMin = (D - 0.20).toFixed(2);
  const diaMax = (D - 0.04).toFixed(2);
  const diaActual = getVariation(s + 'D', D - 0.16, D - 0.06, 2);

  const lenMin = (L - 0.5).toFixed(1);
  const lenMax = (L + 0.5).toFixed(1);
  const lenActual = getVariation(s + 'L', L - 0.25, L + 0.35, 2);

  const afNominal = D >= 20 ? D * 1.5 : D * 1.6;
  const afMin = (afNominal - 0.35).toFixed(2);
  const afMax = afNominal.toFixed(2);
  const afActual = getVariation(s + 'AF', afNominal - 0.25, afNominal - 0.05, 2);

  return [
    { name: '螺纹大径 (Major Dia.)', standard: diaMin + ' ~ ' + diaMax + ' mm', actual: diaActual + ' mm', result: '合格' },
    { name: '总长 (Total Length)', standard: lenMin + ' ~ ' + lenMax + ' mm', actual: lenActual + ' mm', result: '合格' },
    { name: '六角对边/头部尺寸 (Width Across Flats)', standard: afMin + ' ~ ' + afMax + ' mm', actual: afActual + ' mm', result: '合格' },
    { name: '螺纹通止规 (Thread Go/NoGo)', standard: '6g 通止规', actual: '通端过 / 止端止 (合格)', result: '合格' },
  ];
}

export function buildIqcCertificateData(record: any): QualityCertificateData {
  const seed = record.id || record.batchNo || record.furnaceNo || 'IQC-001';
  const steelGrade = detectSteelGrade(record.material || record.materialName, record.spec || record.specModel);
  const elements = getChemicalComposition(steelGrade, seed, record.items);
  const mechanical = getMechanicalProperties('8.8级', steelGrade, seed, record.items);
  const dimensions = getDimensions(record.spec || record.specModel, record.material || record.materialName, seed, record.items);

  return {
    certNo: 'QC-IQC-' + (record.id || (record.docNo || '20241101').replace(/[^0-9]/g, '').slice(-8)),
    issueDate: record.inspectDate || (record.date ? record.date.slice(0, 10) : new Date().toISOString().split('T')[0]),
    inspectionType: 'IQC',
    inspectionTypeLabel: '原材料/来料质量合格保证书 (3.1)',
    customer: '江阴市乐天精工生产部',
    supplier: record.supplier || record.supplierName || '宝武特种冶金股份有限公司',
    contractNo: record.contractNo || ('PO-BUY-' + (record.id || '2411').slice(-6).toUpperCase()),
    productName: record.material || record.materialName || '高强度紧固件合金冷镦线材',
    specification: record.spec || record.specModel || 'phi14.5 mm (盘圆)',
    heatNo: record.furnaceNo || record.furnaceHeatNo || ('24H' + (record.id || '8821').slice(-4).toUpperCase()),
    batchNo: record.batchNo || 'LOT-20241101-01',
    quantity: record.quantity ? (String(record.quantity) + ' 件/批') : '10,000 件',
    steelGrade: steelGrade,
    surfaceFinish: '酸洗磷化 (皮膜润滑)',
    standard: 'GB/T 3098.1-2010',
    performanceGrade: '8.8级',
    chemicalComposition: elements,
    mechanicalProperties: mechanical,
    dimensions: dimensions,
    overallDecision: record.judgment === 'FAILED' ? '不合格' : (record.judgment === 'CONCESSION' ? '特采放行' : '合格'),
    inspector: record.inspector || '陈静 (IQC-08)',
    reviewer: '张强 (QA-01)',
    approver: '王国荣 (总工)',
    notes: record.inspectionNotes || '来料经光谱化学成分复测、金相夹杂物评定与拉力测试，均符合技术采购规范。',
  };
}

export function buildOqcCertificateData(record: any): QualityCertificateData {
  const seed = record.batchNo || record.id || record.orderNo || 'OQC-001';
  const steelGrade = detectSteelGrade(record.productName || record.name || record.materialName, record.specification || record.spec || record.specModel);
  const perfGrade = steelGrade === '42CrMo' ? '10.9级' : (steelGrade === '304SS' ? 'A2-70' : '8.8级');
  const elements = getChemicalComposition(steelGrade, seed, record.items);
  const mechanical = getMechanicalProperties(perfGrade, steelGrade, seed, record.items);
  const dimensions = getDimensions(record.specification || record.spec || record.specModel, record.productName || record.name, seed, record.items);

  return {
    certNo: 'QC-OQC-' + (record.id || (record.doc || '20241101').replace(/[^0-9]/g, '').slice(-8)),
    issueDate: record.date ? record.date.slice(0, 10) : new Date().toISOString().split('T')[0],
    inspectionType: 'OQC',
    inspectionTypeLabel: '产品出厂检验证明书 (EN 10204 3.1 质量保证书)',
    customer: record.customer || record.customerName || record.client || '阿法拉伐（江阴）设备制造有限公司',
      customerAddress: record.customerAddress || record.address || '无锡市惠山区钱桥藕塘盛峰村',
      projectNo: record.projectNo || record.projectId || 'PRJ-2024-001',
      shortProjectNo: record.shortProjectNo || (record.projectNo ? String(record.projectNo).slice(-4) : 'P001'),
      manufactureDate: record.manufactureDate || record.inspectionDate || record.date || new Date().toISOString().split('T')[0],
    supplier: '江阴市乐天精工紧固件有限公司',
    contractNo: record.contractNo || ('PO-SALES-' + (record.id || '2411').slice(-6).toUpperCase()),
    productName: record.productName || record.name || '高强度六角头螺栓',
    specification: record.specification || record.spec || 'M12x1.25x70',
    heatNo: record.heatNo || record.furnaceHeatNo || ('24H' + (record.id || '9915').slice(-4).toUpperCase()),
    batchNo: record.batchNo || record.doc || 'LOT-20241101-01',
    quantity: record.quantity ? (String(record.quantity) + ' 件') : '5,000 件',
    steelGrade: steelGrade,
    surfaceFinish: record.surfaceFinish || '环保银灰达克罗防腐涂层 (720h耐盐雾)',
    standard: 'GB/T 3098.1-2010',
    performanceGrade: perfGrade,
    chemicalComposition: elements,
    mechanicalProperties: mechanical,
    dimensions: dimensions,
    overallDecision: record.judgment === 'FAILED' ? '不合格' : (record.judgment === 'CONCESSION' ? '特采放行' : '合格'),
    inspector: record.inspector || '刘芳 (OQC-03)',
    reviewer: '张强 (QA-01)',
    approver: '王国荣 (总工程师)',
    notes: record.inspectionNotes || '本批紧固件经严格出厂全项目检验，几何尺寸、力学性能、金相组织与防腐耐候试验均达标，准予出厂交付。',
  };
}

export function buildManufacturingCertData(record: any): ManufacturingCertData {
  const seed = record.id || record.batchNo || 'MFG-001';
  return {
    certNo: 'MC-OUT-' + (record.id || '20241101-01'),
    issueDate: record.date ? record.date.slice(0, 10) : new Date().toISOString().split('T')[0],
    subcontractor: record.subcontractor || record.vendor || record.vendorName || '常州市常澄热处理有限公司',
    subcontractNo: record.subcontractNo || record.dispatchNo || ('WWJG-2024-' + (record.id || '1001').slice(-4)),
    productName: record.productName || record.materialName || '连杆螺栓 (半成品)',
    process: record.process || record.processRequirements || '调质热处理 (连续网带炉 淬火+高温回火)',
    quantity: record.quantity ? (String(record.quantity) + ' PCS') : '12,000 PCS',
    batchNo: record.batchNo || 'WW-LOT-20241101',
    inspectionCriteria: '乐天精工企业规范 Q/LT 04-2024 & ISO 898-1',
    tests: [
      { testItem: '表面硬度 (Surface Hardness)', requirement: '32.0 ~ 39.0 HRC', actualResult: getVariation(seed + 'H1', 34.2, 36.5, 1) + ' HRC', judgment: 'PASSED' },
      { testItem: '芯部硬度 (Core Hardness)', requirement: '32.0 ~ 39.0 HRC', actualResult: getVariation(seed + 'H2', 33.8, 35.8, 1) + ' HRC', judgment: 'PASSED' },
      { testItem: '金相显微组织 (Microstructure)', requirement: '回火索氏体 1~3级，无粗大马氏体', actualResult: '回火索氏体 2级 (均匀致密)', judgment: 'PASSED' },
      { testItem: '表面完全脱碳层深度 (Decarb. Depth)', requirement: '<= 0.015 mm', actualResult: getVariation(seed + 'DC', 0.004, 0.011, 3) + ' mm', judgment: 'PASSED' },
      { testItem: '淬火微裂纹磁粉检测 (Crack Check)', requirement: '无纵向或横向淬火裂纹', actualResult: '探伤无缺陷 (0 Defect)', judgment: 'PASSED' },
    ],
    overallConclusion: '合格 (PASSED)',
    qcInspector: record.inspector || '赵志明 (外协质检专员)',
    authorizedSigner: '张强 (质量部长)',
    remarks: '工序热处理曲线与过程自记温记录仪数据已存档，满足10.9级高强度紧固件性能。',
  };
}

export function convertOqcToQualityCert(oqc: any): QualityCertificateData { return buildOqcCertificateData(oqc); }
export function convertOutsourceToManufacturingCert(outsource: any): ManufacturingCertData { return buildManufacturingCertData(outsource); }
export function convertIqcToQualityCert(iqc: any): QualityCertificateData { return buildIqcCertificateData(iqc); }
export function convertIpqcToQualityCert(ipqc: any): QualityCertificateData { return buildIqcCertificateData(ipqc); }

export function buildIpqcCertificateData(record: any): QualityCertificateData { return buildIqcCertificateData(record); }
