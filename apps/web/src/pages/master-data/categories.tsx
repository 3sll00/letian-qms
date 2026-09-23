import React, { useState, useEffect, useMemo } from 'react';
import { Folder, FolderOpen, Search, RefreshCw, Layers, Tag, Plus, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';

interface CategoryTreeNodeView {
  id: string;
  code: string;
  name: string;
  count: number;
  children: CategoryTreeNodeView[];
}

export function MaterialCategoriesPage() {
  const [keyword, setKeyword] = useState('');
  const [categories, setCategories] = useState<CategoryTreeNodeView[]>([]);
  const [selectedNode, setSelectedNode] = useState<CategoryTreeNodeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [creating, setCreating] = useState(false);

    const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCode.trim() || !newName.trim()) return;
    setCreating(true);
    try {
      await api.post('/master-data/categories', {
        categoryCode: newCode.trim(),
        categoryName: newName.trim(),
        parentCode: newParent.trim() || undefined,
        level: newParent.trim() ? 2 : 1,
      });
      setIsCreateOpen(false);
      setNewCode('');
      setNewName('');
      setNewParent('');
      await fetchCategories();
    } catch (err) {
      alert('创建失败: ' + errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const fetchCategories = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<CategoryTreeNodeView[]>('/master-data/categories');
      setCategories(data);
      if (data.length > 0 && !selectedNode) {
        setSelectedNode(data[0] || null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchCategories();
  }, []);

  // 递归统计所有分类总数
  const flattenNodes = (nodes: CategoryTreeNodeView[]): CategoryTreeNodeView[] => {
    const res: CategoryTreeNodeView[] = [];
    const traverse = (list: CategoryTreeNodeView[]) => {
      for (const node of list) {
        res.push(node);
        if (node.children && node.children.length > 0) {
          traverse(node.children);
        }
      }
    };
    traverse(nodes);
    return res;
  };

  const allFlatNodes = useMemo(() => flattenNodes(categories), [categories]);

  // 最大层级深度
  const maxDepth = useMemo(() => {
    const getDepth = (nodes: CategoryTreeNodeView[]): number => {
      if (!nodes || nodes.length === 0) return 0;
      let max = 0;
      for (const n of nodes) {
        max = Math.max(max, 1 + getDepth(n.children || []));
      }
      return max;
    };
    return getDepth(categories);
  }, [categories]);


  // 过滤后的树状展示
  const filterTree = (nodes: CategoryTreeNodeView[], kw: string): CategoryTreeNodeView[] => {
    if (!kw.trim()) return nodes;
    const lower = kw.toLowerCase();
    const result: CategoryTreeNodeView[] = [];
    for (const node of nodes) {
      const matchSelf = node.name.toLowerCase().includes(lower) || node.code.toLowerCase().includes(lower);
      const filteredChildren = filterTree(node.children || [], kw);
      if (matchSelf || filteredChildren.length > 0) {
        result.push({
          ...node,
          children: filteredChildren,
        });
      }
    }
    return result;
  };

  const displayedTree = useMemo(() => filterTree(categories, keyword), [categories, keyword]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-800">存货分类</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            ERP 存货分类层级字典，供「存货档案」与物料权限隔离使用
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            新增分类节点
          </button>
          <button
            type="button"
            onClick={() => void fetchCategories()}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-600 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Main Content: Left Tree / Right Cards & Detail */}
      <div className="flex items-start gap-4">
        {/* Left Tree Card */}
        <div className="w-80 bg-white border border-slate-200/80 rounded-lg p-3 shadow-sm min-h-[460px] flex flex-col">
          <div className="flex items-center gap-2 px-2.5 py-2 rounded bg-amber-50/50 text-slate-700 font-medium text-xs border border-amber-100/60 mb-2.5">
            <Folder className="w-4 h-4 text-amber-500 shrink-0" />
            <span className="font-semibold">分类目录树</span>
            <span className="text-[11px] text-slate-400 ml-auto">{allFlatNodes.length} 个节点</span>
          </div>

          <div className="mb-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
              <input
                type="text"
                placeholder="搜索分类名称 / 编码"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="border border-slate-200 rounded pl-8 pr-2.5 py-1.5 w-full text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 text-xs pr-1">
            {loading ? (
              <div className="py-12 text-center text-slate-400">加载分类树中...</div>
            ) : displayedTree.length === 0 ? (
              <div className="py-12 text-center text-slate-400">未找到匹配分类</div>
            ) : (
              displayedTree.map((node) => (
                <TreeNodeItem
                  key={node.id || node.code}
                  node={node}
                  depth={0}
                  selectedNode={selectedNode}
                  onSelect={setSelectedNode}
                />
              ))
            )}
          </div>
        </div>

        {/* Right 3 Stat Cards + Selected Detail */}
        <div className="flex-1 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
              <div className="text-2xl font-bold text-slate-800 font-mono">{allFlatNodes.length}</div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-blue-500" />
                分类总数 (含子类)
              </div>
            </div>
            <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
              <div className="text-2xl font-bold text-slate-800 font-mono">{categories.length}</div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                <Folder className="w-3.5 h-3.5 text-amber-500" />
                一级大类
              </div>
            </div>
            <div className="bg-white border border-slate-200/80 rounded-lg p-4 shadow-sm">
              <div className="text-2xl font-bold text-slate-800 font-mono">{maxDepth}</div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                <Tag className="w-3.5 h-3.5 text-emerald-500" />
                最大层级深度
              </div>
            </div>
          </div>

          {/* Selected Node Details */}
          <div className="bg-white border border-slate-200/80 rounded-lg p-5 shadow-sm min-h-[340px]">
            <h3 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3 mb-4 flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-blue-600" />
              分类详情与下属物料
            </h3>

            {selectedNode ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-lg text-xs">
                  <div>
                    <span className="text-slate-400">分类编码: </span>
                    <span className="font-mono font-medium text-blue-600 ml-1">{selectedNode.code}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">分类名称: </span>
                    <span className="font-medium text-slate-800 ml-1">{selectedNode.name}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">下属料品数: </span>
                    <span className="font-bold text-slate-800 ml-1">{selectedNode.count} 种</span>
                  </div>
                  <div>
                    <span className="text-slate-400">直接子类别数: </span>
                    <span className="font-medium text-slate-800 ml-1">{selectedNode.children?.length || 0} 个</span>
                  </div>
                </div>

                {selectedNode.children && selectedNode.children.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-slate-700 mb-2">包含的子分类:</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {selectedNode.children.map((sub) => (
                        <div
                          key={sub.id || sub.code}
                          onClick={() => setSelectedNode(sub)}
                          className="flex items-center justify-between p-2 rounded border border-slate-200 bg-white hover:bg-blue-50/60 cursor-pointer transition text-xs"
                        >
                          <span className="font-medium text-slate-700">{sub.name}</span>
                          <span className="font-mono text-slate-400 text-[11px]">{sub.code} ({sub.count}件)</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-20 text-center text-slate-400 text-xs">
                请在左侧点击选择分类查看详情
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 新增分类 Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2">
                <Folder className="w-4 h-4 text-amber-500" />
                <h3 className="font-bold text-sm text-slate-800">新增存货分类节点</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="text-slate-400 hover:text-slate-600 transition p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateCategory} className="p-5 space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  分类编码 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: 0103 或 FASTENER_BOLT"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  分类名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如: 特殊高强度紧固件"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  父级分类编码 (可选，留空为一级根分类)
                </label>
                <input
                  type="text"
                  placeholder="例如: 01 或留空"
                  value={newParent}
                  onChange={(e) => setNewParent(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition shadow-sm disabled:opacity-50"
                >
                  {creating ? '保存中...' : '确认创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function TreeNodeItem({
  node,
  depth,
  selectedNode,
  onSelect,
}: {
  node: CategoryTreeNodeView;
  depth: number;
  selectedNode: CategoryTreeNodeView | null;
  onSelect: (n: CategoryTreeNodeView) => void;
}) {
  const isSelected = selectedNode?.code === node.code;
  const hasChildren = Boolean(node.children && node.children.length > 0);

  return (
    <div>
      <div
        onClick={() => onSelect(node)}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        className={`flex items-center justify-between pr-2.5 py-1.5 rounded cursor-pointer transition ${
          isSelected
            ? 'bg-blue-50 text-blue-600 font-semibold'
            : 'text-slate-700 hover:bg-slate-50'
        }`}
      >
        <div className="flex items-center gap-1.5 truncate">
          <span className="text-amber-500 text-xs">{hasChildren ? '📁' : '📄'}</span>
          <span className="truncate">{node.name}</span>
        </div>
        <span className="text-[11px] text-slate-400 font-mono ml-2 shrink-0">{node.count}</span>
      </div>

      {hasChildren &&
        node.children.map((child) => (
          <TreeNodeItem
            key={child.id || child.code}
            node={child}
            depth={depth + 1}
            selectedNode={selectedNode}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}