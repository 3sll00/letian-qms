import React, { useState, useEffect } from 'react';
import {
  FolderTree,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  Plus,
  Layers,
  Package,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';

// 契约包中没有分类树 Schema，类型按 GET /master-data/categories 的真实返回结构声明
// （见 apps/api/src/controllers/master-data.controller.ts 的 CategoryTreeNodeView）。
interface CategoryTreeNode {
  id: string;
  code: string;
  name: string;
  count: number;
  children: CategoryTreeNode[];
}

/** 分类代码 → 质检阶段（原实现按 Mock 主键 id 里的 raw/semi 关键字判断，真实库主键是 UUID，改判代码） */
function stageOfCategory(code: string, name: string): string {
  const key = `${code} ${name}`.toUpperCase();
  if (key.includes('RAW')) return 'IQC 进货来料检验';
  if (key.includes('SEMI')) return 'IPQC 过程制程检验';
  return 'FQC 成品终检出厂';
}

export function MaterialCategoriesPage() {
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<CategoryTreeNode | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<CategoryTreeNode[]>('/master-data/categories')
      .then((data) => {
        setCategories(data);
        if (data.length > 0) {
          setSelectedCategory(data[0]);
        }
        // 默认展开全部根节点（原实现硬编码 'cat-raw' 等键，与库中 UUID 主键不匹配，永远展不开）
        setExpandedKeys(Object.fromEntries(data.map((node) => [node.id, true])));
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(errorMessage(err));
        console.error('Categories error:', err);
      });
  }, []);

  const countNodes = (items: CategoryTreeNode[]): number =>
    items.reduce((sum, item) => sum + 1 + countNodes(item.children), 0);

  const toggleExpand = (id: string) => {
    setExpandedKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderTree = (items: CategoryTreeNode[], depth = 0) => {
    return (
      <div className="space-y-1">
        {items.map((item) => {
          const hasChildren = item.children && item.children.length > 0;
          const isExpanded = !!expandedKeys[item.id];
          const isSelected = selectedCategory?.id === item.id;

          return (
            <div key={item.id} className="text-xs">
              <div
                style={{ paddingLeft: `${depth * 18 + 8}px` }}
                onClick={() => {
                  setSelectedCategory(item);
                  if (hasChildren) toggleExpand(item.id);
                }}
                className={`flex items-center justify-between py-2 pr-3 rounded-lg cursor-pointer transition ${
                  isSelected
                    ? 'bg-sky-600/20 text-sky-400 border border-sky-500/40'
                    : 'hover:bg-slate-800/60 text-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(item.id);
                      }}
                      className="p-0.5 text-slate-400 hover:text-white"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                  ) : (
                    <span className="w-3.5 inline-block" />
                  )}

                  {hasChildren ? (
                    isExpanded ? (
                      <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />
                    ) : (
                      <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                    )
                  ) : (
                    <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                  )}

                  <span className="font-mono text-slate-400 text-[11px]">{item.code}</span>
                  <span className="font-medium text-white truncate">{item.name}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">
                    {item.count} 项物料
                  </span>
                </div>
              </div>

              {hasChildren && isExpanded && renderTree(item.children, depth + 1)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-xl">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <FolderTree className="w-5 h-5 text-sky-400" />
            紧固件物料分类树结构与工程规程映射中心
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            支持母料盘圆、中间胚料、切断半成品、热处理螺栓与汽车级成品全层级树状管理
          </p>
        </div>
        <button className="flex items-center gap-1.5 px-3.5 py-2 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-lg shadow-lg shadow-sky-600/30 transition">
          <Plus className="w-4 h-4" />
          新增分类节点
        </button>
      </div>

      {loadError ? (
        <div className="bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs rounded-xl px-4 py-3">
          物料分类树加载失败: {loadError}
        </div>
      ) : null}

      {/* Main Split View: Left Tree + Right Node Detail */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Tree (5 cols) */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-xl space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-400" />
              全厂料品分类层级树
            </h3>
            <span className="text-xs text-slate-400 font-mono">
              {categories.length} 大根类 · {countNodes(categories)} 节点
            </span>
          </div>

          <div className="py-2">{renderTree(categories)}</div>
        </div>

        {/* Right Column: Node Details & Inspection Binding (7 cols) */}
        <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
          {selectedCategory ? (
            <>
              <div className="border-b border-slate-800 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Package className="w-5 h-5 text-sky-400" />
                    <h3 className="font-semibold text-white text-base">
                      {selectedCategory.name}
                    </h3>
                  </div>
                  <span className="font-mono text-xs text-sky-400 bg-sky-950/80 px-2 py-0.5 rounded border border-sky-500/30">
                    分类代码: {selectedCategory.code}
                  </span>
                </div>
                <div className="text-xs text-slate-400 mt-2">
                  当前该分类节点下已纳管登记 <span className="text-white font-bold">{selectedCategory.count}</span> 款精密紧固件物料。
                </div>
              </div>

              {/* Bound Inspection Criteria */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  默认绑定的全厂检验规程与质控等级
                </h4>
                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <span className="text-slate-400">质检阶段类型:</span>
                      <div className="font-mono text-white font-bold mt-0.5">
                        {stageOfCategory(selectedCategory.code, selectedCategory.name)}
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400">适用抽样方案:</span>
                      <div className="font-mono text-amber-300 font-bold mt-0.5">
                        GB/T 2828.1 正常检验 Level II (AQL 0.40)
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/80">
                    <span className="text-slate-400">质控重点指标:</span>
                    <div className="text-slate-200 mt-1">
                      线径外径公差、化学成分五大元素谱分析、拉力强度试验、硬度梯度分布、螺纹 6g 通止规
                    </div>
                  </div>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="pt-4 border-t border-slate-800 flex justify-end gap-3">
                <button className="px-3.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700">
                  编辑当前分类
                </button>
                <button className="px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow">
                  变更绑定检验规程
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-64 text-slate-400">
              请选择左侧树节点查看详情
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
