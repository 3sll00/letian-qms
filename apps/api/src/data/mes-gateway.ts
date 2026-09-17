/**
 * MES 工控网关档案（设备映射与拦截规则）
 *
 * ⚠️ 数据边界说明（重要）：
 * 1. 契约包中没有设备映射与拦截规则的 Schema，数据库也没有对应表；
 *    因此这两份档案目前是**进程内静态目录**，不是持久化数据。
 * 2. 车间接线取自库中真实的 workshops（WS-01 ~ WS-04）主数据，避免出现与主数据冲突的车间编码。
 * 3. PUT /integration/equipment/:id/status 只修改进程内的 devices 状态，
 *    进程重启即恢复初始值；真正落地需要新增设备表 + 迁移 + 契约扩展。
 * 4. 除本文件外，API 侧没有任何地方读写设备状态。
 */

export interface MesEquipmentView {
  id: string;
  equipmentCode: string;
  equipmentName: string;
  stationCode: string;
  workshop: string;
  protocol: string;
  ipAddress: string;
  status: 'ONLINE' | 'INTERCEPTED' | 'OFFLINE';
}

export interface MesInterceptionRuleView {
  id: string;
  ruleName: string;
  stage: string;
  condition: string;
  action: string;
  autoLock: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

/** 工控机与 PLC 停机联动设备清单（进程内可变，status 可被手动拦截接口改写） */
export const MES_EQUIPMENT_CATALOG: MesEquipmentView[] = [
  {
    id: 'eq-cold-header-01',
    equipmentCode: 'EQ-CDH-01',
    equipmentName: '高速冷镦机 #1 (五模五冲)',
    stationCode: 'ST-CDH-01',
    workshop: 'WS-01 高速冷镦第一车间',
    protocol: 'OPC UA',
    ipAddress: '192.168.10.21',
    status: 'ONLINE',
  },
  {
    id: 'eq-cold-header-02',
    equipmentCode: 'EQ-CDH-02',
    equipmentName: '高速冷镦机 #2 (四模四冲)',
    stationCode: 'ST-CDH-02',
    workshop: 'WS-01 高速冷镦第一车间',
    protocol: 'OPC UA',
    ipAddress: '192.168.10.22',
    status: 'ONLINE',
  },
  {
    id: 'eq-thread-roller-01',
    equipmentCode: 'EQ-THR-01',
    equipmentName: '精密搓丝机 #1 (行星式)',
    stationCode: 'ST-THR-01',
    workshop: 'WS-02 精密搓丝成型第二车间',
    protocol: 'Modbus TCP',
    ipAddress: '192.168.10.31',
    status: 'ONLINE',
  },
  {
    id: 'eq-thread-roller-02',
    equipmentCode: 'EQ-THR-02',
    equipmentName: '精密搓丝机 #2 (平板式)',
    stationCode: 'ST-THR-02',
    workshop: 'WS-02 精密搓丝成型第二车间',
    protocol: 'Modbus TCP',
    ipAddress: '192.168.10.32',
    status: 'INTERCEPTED',
  },
  {
    id: 'eq-heat-treat-01',
    equipmentCode: 'EQ-HTT-01',
    equipmentName: '连续式网带调质炉 #1',
    stationCode: 'ST-HTT-01',
    workshop: 'WS-03 连续式网带调质热处理车间',
    protocol: 'MQTT',
    ipAddress: '192.168.10.41',
    status: 'ONLINE',
  },
  {
    id: 'eq-heat-treat-02',
    equipmentCode: 'EQ-HTT-02',
    equipmentName: '连续式网带回火炉 #2',
    stationCode: 'ST-HTT-02',
    workshop: 'WS-03 连续式网带调质热处理车间',
    protocol: 'MQTT',
    ipAddress: '192.168.10.42',
    status: 'ONLINE',
  },
  {
    id: 'eq-plating-01',
    equipmentCode: 'EQ-PLT-01',
    equipmentName: '环保自动化电镀流水线 #1',
    stationCode: 'ST-PLT-01',
    workshop: 'WS-04 环保自动化电镀流水线车间',
    protocol: 'OPC UA',
    ipAddress: '192.168.10.51',
    status: 'ONLINE',
  },
  {
    id: 'eq-plating-02',
    equipmentCode: 'EQ-PLT-02',
    equipmentName: '环保自动化电镀流水线 #2',
    stationCode: 'ST-PLT-02',
    workshop: 'WS-04 环保自动化电镀流水线车间',
    protocol: 'OPC UA',
    ipAddress: '192.168.10.52',
    status: 'ONLINE',
  },
];

/** 质量门禁自动阻断规则策略库（只读静态目录） */
export const MES_INTERCEPTION_RULES: MesInterceptionRuleView[] = [
  {
    id: 'rule-iqc-hardness',
    ruleName: '来料硬度超差硬阻断',
    stage: 'IQC 来料检验',
    condition: 'HRC 实测值 > 上限 或 < 下限',
    action: 'PLC 抱闸停机 + 红标报警',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-iqc-dimension',
    ruleName: '来料关键尺寸超差',
    stage: 'IQC 来料检验',
    condition: '外径/长度 超出公差带',
    action: '看板报警 + 转 MRB 评审',
    autoLock: false,
    status: 'ACTIVE',
  },
  {
    id: 'rule-ipqc-cut',
    ruleName: '下料工段首检不合格',
    stage: 'IPQC 下料 (IPQC_CT)',
    condition: '首件任一检验项判定 FAILED',
    action: 'PLC 抱闸停机',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-ipqc-cold-header',
    ruleName: '冷镦工段连续不合格',
    stage: 'IPQC 冷镦 (IPQC_RL)',
    condition: '连续 3 件判定 FAILED',
    action: 'PLC 抱闸停机 + 停机挂牌',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-oqc-final-gate',
    ruleName: '成品终检强制放行关卡',
    stage: 'OQC 出货检验',
    condition: '放行关卡校验返回 409 阻断',
    action: 'WMS/MES 禁止过站与发货',
    autoLock: true,
    status: 'ACTIVE',
  },
  {
    id: 'rule-mrb-concession',
    ruleName: '特采让步接收受限流转',
    stage: 'MRB 处置环节',
    condition: 'MRB 处置决议为 CONCESSION',
    action: '允许受限流转 + 全程追溯留痕',
    autoLock: false,
    status: 'ACTIVE',
  },
];
