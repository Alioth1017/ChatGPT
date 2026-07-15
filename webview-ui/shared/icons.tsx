/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Clock,
  ChevronRight,
  Circle,
  CircleDot,
  Code2,
  Database,
  FileCode,
  FileSearch,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  BookOpen,
  Copy,
  History as HistoryIcon,
  Image as ImageIcon,
  Infinity as InfinityIcon,
  Link as LinkIcon,
  ListChecks,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Download,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Ruler,
  Search,
  Settings,
  Sparkles,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

const MAP = {
  file: FileText,
  folder: Folder,
  search: Search,
  terminal: Terminal,
  edit: Pencil,
  trash: Trash2,
  reset: RotateCcw,
  check: Check,
  close: X,
  chevD: ChevronDown,
  chevR: ChevronRight,
  brain: Brain,
  history: HistoryIcon,
  infinity: InfinityIcon,
  agent: Sparkles,
  bot: Bot,
  chat: MessageSquare,
  list: ListChecks,
  plus: Plus,
  settings: Settings,
  model: SlidersHorizontal,
  tools: Wrench,
  code: Code2,
  fileCode: FileCode,
  database: Database,
  fileSearch: FileSearch,
  globe: Globe,
  link: LinkIcon,
  todo: ListTodo,
  ruler: Ruler,
  task: Bot,
  image: ImageIcon,
  paperclip: Paperclip,
  circle: Circle,
  circleDot: CircleDot,
  clock: Clock,
  play: Play,
  gitBranch: GitBranch,
  gitCommit: GitCommitHorizontal,
  book: BookOpen,
  more: MoreHorizontal,
  download: Download,
  copy: Copy,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof MAP;

export function Icon({
  name,
  className,
  size = 16,
}: {
  name: IconName;
  className?: string;
  size?: number;
}) {
  const Cmp = MAP[name];
  return <Cmp className={className} size={size} strokeWidth={1.75} absoluteStrokeWidth />;
}
