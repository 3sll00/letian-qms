import React, { useState } from "react";
import { X } from "lucide-react";
import { api, errorMessage } from "../../lib/api";

export type MasterDataTab = "supplier" | "customer" | "inventory" | "workshop" | "employee";

export function CreateMasterDataModal({
  tab,
  onClose,
  onSuccess,
}: {
  tab: MasterDataTab;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const title = {
    supplier: "新增供应商档案",
    customer: "新增客户档案",
    inventory: "新增存货料品档案",
    workshop: "新增生产车间档案",
    employee: "新增职员与检验员",
  }[tab];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (tab === "supplier") {
        await api.post("/master-data/suppliers", {
          supplierCode: form.supplierCode?.trim(),
          supplierName: form.supplierName?.trim(),
          contactPerson: form.contactPerson?.trim() || undefined,
          phone: form.phone?.trim() || undefined,
        });
      } else if (tab === "customer") {
        await api.post("/master-data/customers", {
          customerCode: form.customerCode?.trim(),
          customerName: form.customerName?.trim(),
          contactPerson: form.contactPerson?.trim() || undefined,
          phone: form.phone?.trim() || undefined,
        });
      } else if (tab === "inventory") {
        await api.post("/master-data/inventory", {
          materialCode: form.materialCode?.trim(),
          materialName: form.materialName?.trim(),
          specModel: form.specModel?.trim() || undefined,
          categoryCode: form.categoryCode?.trim(),
          unit: form.unit?.trim() || "PCS",
        });
      } else if (tab === "workshop") {
        await api.post("/master-data/workshops", {
          workshopCode: form.workshopCode?.trim(),
          workshopName: form.workshopName?.trim(),
        });
      } else if (tab === "employee") {
        await api.post("/master-data/employees", {
          employeeCode: form.employeeCode?.trim(),
          name: form.name?.trim(),
          department: form.department?.trim() || undefined,
          phone: form.phone?.trim() || undefined,
          email: form.email?.trim() || undefined,
        });
      }
      onSuccess();
    } catch (err) {
      alert("保存失败: " + errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="font-bold text-sm text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {tab === "supplier" && (
            <>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  供应商编码 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: SUP-2026-001"
                  value={form.supplierCode || ""}
                  onChange={(e) => setForm({ ...form, supplierCode: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  供应商全称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: 宝武精特钢铁股份有限公司"
                  value={form.supplierName || ""}
                  onChange={(e) => setForm({ ...form, supplierName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">联系人</label>
                  <input
                    type="text"
                    placeholder="例如: 张经理"
                    value={form.contactPerson || ""}
                    onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">联系电话</label>
                  <input
                    type="text"
                    placeholder="例如: 13800000000"
                    value={form.phone || ""}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
              </div>
            </>
          )}

          {tab === "customer" && (
            <>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  客户编码 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: CUST-2026-001"
                  value={form.customerCode || ""}
                  onChange={(e) => setForm({ ...form, customerCode: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  客户名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: 中国中车轨道交通有限公司"
                  value={form.customerName || ""}
                  onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">对接联系人</label>
                  <input
                    type="text"
                    placeholder="例如: 李工程师"
                    value={form.contactPerson || ""}
                    onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">联系电话</label>
                  <input
                    type="text"
                    placeholder="例如: 13900000000"
                    value={form.phone || ""}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
              </div>
            </>
          )}

          {tab === "inventory" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    物料编码 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="例如: MAT-2026-001"
                    value={form.materialCode || ""}
                    onChange={(e) => setForm({ ...form, materialCode: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    分类编码 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="例如: 01 或 0101"
                    value={form.categoryCode || ""}
                    onChange={(e) => setForm({ ...form, categoryCode: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  存货料品名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: 六角头螺栓 M12*65"
                  value={form.materialName || ""}
                  onChange={(e) => setForm({ ...form, materialName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">规格型号</label>
                  <input
                    type="text"
                    placeholder="例如: 10.9级 达克罗"
                    value={form.specModel || ""}
                    onChange={(e) => setForm({ ...form, specModel: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    计量单位 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="例如: PCS / KG"
                    value={form.unit || "PCS"}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </>
          )}

          {tab === "workshop" && (
            <>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  车间编码 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: WS-01"
                  value={form.workshopCode || ""}
                  onChange={(e) => setForm({ ...form, workshopCode: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  车间名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: 冷镦成型一车间"
                  value={form.workshopName || ""}
                  onChange={(e) => setForm({ ...form, workshopName: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                />
              </div>
            </>
          )}

          {tab === "employee" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    职员工号 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="例如: EMP-2026-01"
                    value={form.employeeCode || ""}
                    onChange={(e) => setForm({ ...form, employeeCode: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    职员姓名 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="例如: 王志强"
                    value={form.name || ""}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">所属部门 / 岗位</label>
                <input
                  type="text"
                  placeholder="例如: 质量检验部 / 来料检验员"
                  value={form.department || ""}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">联系电话</label>
                  <input
                    type="text"
                    placeholder="例如: 13700000000"
                    value={form.phone || ""}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">邮箱地址</label>
                  <input
                    type="email"
                    placeholder="例如: zq.wang@letian.com"
                    value={form.email || ""}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full border border-slate-300 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 transition disabled:opacity-50"
            >
              {submitting ? "保存中..." : "确认保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
