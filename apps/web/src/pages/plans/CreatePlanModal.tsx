import React, { useState } from 'react';
import { X, Plus, Trash2, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';

interface PlanItemRow {
  seq: number;
  itemCode: string;
  name: string;
  dataType: 'NUMERIC' | 'BOOLEAN';
  metricCategory: 'APPEARANCE' | 'DIMENSION' | 'PERFORMANCE' | 'CHEMICAL';
  nominalValue?: number;
  upperTolerance?: number;
  lowerTolerance?: number;
  unit: string;
  measurementTool: string;
  sampleSize: number;
}

interface CreatePlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreatePlanModal({ isOpen, onClose, onSuccess }: CreatePlanModalProps) {
  const [planCode, setPlanCode] = useState(`QP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}`);
  const [planName, setPlanName] = useState('');
  const [inspectionType, setInspectionType] = useState('IQC');
  const [materialCode, setMaterialCode] = useState('');
  const [aqlLevel, setAqlLevel] = useState('II');
  const [strictness, setStrictness] = useState('NORMAL');
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<PlanItemRow[]>([
    {
      seq: 1,
      itemCode: 'DIM-01',
      name: '外径尺寸',
      dataType: 'NUMERIC',
      metricCategory: 'DIMENSION',
      nominalValue: 12.0,
      upperTolerance: 0.1,
      lowerTolerance: -0.1,
      unit: 'mm',
      measurementTool: '外径千分尺',
      sampleSize: 5,
    },
    {
      seq: 2,
      itemCode: 'APP-01',
      name: '表面裂纹与毛刺',
      dataType: 'BOOLEAN',
      metricCategory: 'APPEARANCE',
      unit: '外观',
      measurementTool: '目视/放大镜',
      sampleSize: 8,
    },
  ]);

  if (!isOpen) return null;

  const handleAddItem = () => {
    const nextSeq = items.length + 1;
    setItems([
      ...items,
      {
        seq: nextSeq,
        itemCode: `ITEM-0${nextSeq}`,
        name: `检验项目 ${nextSeq}`,
        dataType: 'NUMERIC',
        metricCategory: 'DIMENSION',
        nominalValue: 10.0,
        upperTolerance: 0.05,
        lowerTolerance: -0.05,
        unit: 'mm',
        measurementTool: '游标卡尺',
        sampleSize: 5,
      },
    ]);
  };

  const handleRemoveItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const handleItemChange = (index: number, field: keyof PlanItemRow, val: any) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: val };
    setItems(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planName.trim()) {
      alert('请填写方案名称');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/plans', {
        planCode,
        planName,
        inspectionType,
        materialCode: materialCode.trim() || undefined,
        versions: [
          {
            versionNo: 'V1.0',
            samplingScheme: 'GB_T_2828',
            aqlLevel,
            strictness,
            status: 'ACTIVE',
            items: items.map((it, idx) => ({
              seq: idx + 1,
              itemCode: it.itemCode,
              name: it.name,
              dataType: it.dataType,
              metricCategory: it.metricCategory,
              nominalValue: it.nominalValue,
              upperTolerance: it.upperTolerance,
              lowerTolerance: it.lowerTolerance,
              unit: it.unit,
              measurementTool: it.measurementTool,
              sampleSize: it.sampleSize,
              isMandatory: true,
            })),
          },
        ],
      });
      alert('质检方案已创建成功！');
      onSuccess();
      onClose();
    } catch (err: any) {
      alert(`创建方案失败: ${err.message || '网络或校验异常'}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-800">新建质检方案与公差矩阵</h2>
              <p className="text-xs text-slate-500">配置工序质检基准、GB/T 2828 AQL 抽样参数与上下公差</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-200/60 text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Section 1: Basic Info */}
          <div>
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">1. 基础配置信息</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">方案编号 <span className="text-rose-500">*</span></label>
                <input
                  type="text"
                  required
                  value={planCode}
                  onChange={(e) => setPlanCode(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">方案名称 <span className="text-rose-500">*</span></label>
                <input
                  type="text"
                  required
                  placeholder="如: 高强度螺栓来料检验标准"
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">检验工序阶段 <span className="text-rose-500">*</span></label>
                <select
                  value={inspectionType}
                  onChange={(e) => setInspectionType(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                >
                  <option value="IQC">来料检验 (IQC)</option>
                  <option value="IPQC_CT">下料检验 (IPQC_CT)</option>
                  <option value="IPQC_RL">滚丝检验 (IPQC_RL)</option>
                  <option value="IPQC_FN">过程成品检验 (IPQC_FN)</option>
                  <option value="OQC_SF">成品出货检验 (OQC_SF)</option>
                  <option value="OQC_SH">发货检验 (OQC_SH)</option>
                  <option value="OQC_HEAT">委外热处理 (OQC_HEAT)</option>
                  <option value="OQC_BLACK">委外发黑 (OQC_BLACK)</option>
                  <option value="OQC_ZINC">委外镀锌 (OQC_ZINC)</option>
                  <option value="OQC_NICKEL">委外镀镍 (OQC_NICKEL)</option>
                  <option value="OQC_PHOSPH">委外磷化 (OQC_PHOSPH)</option>
                  <option value="OQC_DACRO">委外达克罗 (OQC_DACRO)</option>
                  <option value="OQC_MACH">委外机加工 (OQC_MACH)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">专属物料编码 (空为全通用)</label>
                <input
                  type="text"
                  placeholder="如: MAT-BOLT-M12"
                  value={materialCode}
                  onChange={(e) => setMaterialCode(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Section 2: AQL Sampling */}
          <div>
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">2. GB/T 2828 抽样方案配置</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-slate-50 p-3.5 rounded-lg border border-slate-200">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">抽样检验水准</label>
                <select
                  value={aqlLevel}
                  onChange={(e) => setAqlLevel(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-300 bg-white"
                >
                  <option value="I">特殊检验水准 S-1</option>
                  <option value="II">一般检验水准 II (标准推荐)</option>
                  <option value="III">一般检验水准 III (加严)</option>
                  <option value="S-3">特殊检验水准 S-3</option>
                  <option value="S-4">特殊检验水准 S-4</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">宽严度规则</label>
                <select
                  value={strictness}
                  onChange={(e) => setStrictness(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-300 bg-white"
                >
                  <option value="NORMAL">正常检验 (Normal)</option>
                  <option value="TIGHTENED">加严检验 (Tightened)</option>
                  <option value="REDUCED">放宽检验 (Reduced)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">允收质量限 (AQL)</label>
                <input
                  type="text"
                  disabled
                  value="1.0 (自动根据批量查表)"
                  className="w-full h-8 px-2.5 text-xs rounded-md border border-slate-200 bg-slate-100 text-slate-500"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Inspection Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">3. 质检项目与公差规格矩阵 ({items.length}项)</h3>
              <button
                type="button"
                onClick={handleAddItem}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium px-2 py-1 rounded hover:bg-blue-50"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新增指标</span>
              </button>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100 text-slate-700 font-medium border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3 w-12 text-center">序号</th>
                    <th className="py-2 px-3">指标名称</th>
                    <th className="py-2 px-3 w-24">类别</th>
                    <th className="py-2 px-3 w-20">数据类型</th>
                    <th className="py-2 px-3 w-20">标准值</th>
                    <th className="py-2 px-3 w-20">上公差(+)</th>
                    <th className="py-2 px-3 w-20">下公差(-)</th>
                    <th className="py-2 px-3 w-16">单位</th>
                    <th className="py-2 px-3 w-24">检验工具</th>
                    <th className="py-2 px-3 w-16 text-center">样本量</th>
                    <th className="py-2 px-2 w-10 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {items.map((it, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/60">
                      <td className="py-2 px-3 text-center text-slate-400">{idx + 1}</td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          required
                          value={it.name}
                          onChange={(e) => handleItemChange(idx, 'name', e.target.value)}
                          className="w-full h-7 px-2 text-xs border border-slate-200 rounded focus:border-blue-500"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <select
                          value={it.metricCategory}
                          onChange={(e) => handleItemChange(idx, 'metricCategory', e.target.value)}
                          className="w-full h-7 px-1.5 text-xs border border-slate-200 rounded bg-white"
                        >
                          <option value="DIMENSION">尺寸</option>
                          <option value="APPEARANCE">外观</option>
                          <option value="PERFORMANCE">性能</option>
                          <option value="CHEMICAL">化学成分</option>
                        </select>
                      </td>
                      <td className="py-2 px-3">
                        <select
                          value={it.dataType}
                          onChange={(e) => handleItemChange(idx, 'dataType', e.target.value)}
                          className="w-full h-7 px-1.5 text-xs border border-slate-200 rounded bg-white"
                        >
                          <option value="NUMERIC">数值</option>
                          <option value="BOOLEAN">定性</option>
                        </select>
                      </td>
                      <td className="py-2 px-3">
                        {it.dataType === 'NUMERIC' ? (
                          <input
                            type="number"
                            step="any"
                            value={it.nominalValue ?? ''}
                            onChange={(e) => handleItemChange(idx, 'nominalValue', parseFloat(e.target.value) || 0)}
                            className="w-full h-7 px-2 text-xs border border-slate-200 rounded"
                          />
                        ) : (
                          <span className="text-slate-400 text-[11px]">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        {it.dataType === 'NUMERIC' ? (
                          <input
                            type="number"
                            step="any"
                            value={it.upperTolerance ?? ''}
                            onChange={(e) => handleItemChange(idx, 'upperTolerance', parseFloat(e.target.value) || 0)}
                            className="w-full h-7 px-2 text-xs border border-slate-200 rounded"
                          />
                        ) : (
                          <span className="text-slate-400 text-[11px]">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        {it.dataType === 'NUMERIC' ? (
                          <input
                            type="number"
                            step="any"
                            value={it.lowerTolerance ?? ''}
                            onChange={(e) => handleItemChange(idx, 'lowerTolerance', parseFloat(e.target.value) || 0)}
                            className="w-full h-7 px-2 text-xs border border-slate-200 rounded"
                          />
                        ) : (
                          <span className="text-slate-400 text-[11px]">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={it.unit}
                          onChange={(e) => handleItemChange(idx, 'unit', e.target.value)}
                          className="w-full h-7 px-1.5 text-xs border border-slate-200 rounded"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={it.measurementTool}
                          onChange={(e) => handleItemChange(idx, 'measurementTool', e.target.value)}
                          className="w-full h-7 px-1.5 text-xs border border-slate-200 rounded"
                        />
                      </td>
                      <td className="py-2 px-3 text-center">
                        <input
                          type="number"
                          min="1"
                          value={it.sampleSize}
                          onChange={(e) => handleItemChange(idx, 'sampleSize', parseInt(e.target.value, 10) || 1)}
                          className="w-12 h-7 px-1 text-xs text-center border border-slate-200 rounded"
                        />
                      </td>
                      <td className="py-2 px-2 text-center">
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(idx)}
                            className="text-slate-400 hover:text-rose-600 p-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 shadow-sm"
            >
              {submitting ? '保存中...' : '确认发布新方案'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
