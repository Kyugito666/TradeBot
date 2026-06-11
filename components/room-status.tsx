"use client";

import React from "react";
import { MessageSquare, Shield, Zap, Send, Eye, ArrowRight } from "lucide-react";

const ROOMS = [
  { name: "Discussion", icon: MessageSquare, desc: "13 agents analyze market", color: "text-blue-400", bg: "bg-blue-500/10" },
  { name: "Consensus", icon: Eye, desc: "Majority vote (LONG/SHORT only)", color: "text-purple-400", bg: "bg-purple-500/10" },
  { name: "Risk", icon: Shield, desc: "Quant veto + circuit breaker", color: "text-red-400", bg: "bg-red-500/10" },
  { name: "Execution", icon: Zap, desc: "Limit order placement", color: "text-amber-400", bg: "bg-amber-500/10" },
  { name: "Courier", icon: Send, desc: "Deliver signal to engine", color: "text-emerald-400", bg: "bg-emerald-500/10" },
];

export function RoomStatusStrip() {
  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/40 bg-card/30 px-3 py-2">
      <span className="mr-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground whitespace-nowrap">
        Signal Pipeline
      </span>
      {ROOMS.map((room, i) => {
        const Icon = room.icon;
        return (
          <React.Fragment key={room.name}>
            <div
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${room.bg} transition-colors hover:brightness-125 cursor-default`}
              title={room.desc}
            >
              <Icon size={11} className={room.color} />
              <span className={`text-[10px] font-medium ${room.color} whitespace-nowrap`}>
                {room.name}
              </span>
            </div>
            {i < ROOMS.length - 1 && (
              <ArrowRight size={10} className="shrink-0 text-muted-foreground/40" />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
