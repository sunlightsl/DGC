/** 游戏说明弹窗：Tab 切换两个游戏的说明 */

const TABS = [
  { key: 'bullet', label: '小电机弹幕' },
  { key: 'versus', label: '电击消消乐' },
  { key: 'roulette', label: '俄罗斯轮盘' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export const BULLET_HTML = `
  <p>单人弹幕射击，受击实时联动 <b>郊狼 / 负鼠 / 灵猫</b> 三设备：</p>
  <ol>
    <li><b>郊狼</b>：受击时输出电击脉冲，低血量时持续警告，死亡时一波爆发</li>
    <li><b>负鼠</b>：受击时振动反馈，炸弹触发奖励振动</li>
    <li><b>灵猫</b>：作为输入设备 —— 游戏中捏压触发炸弹，清空全屏敌弹</li>
  </ol>

  <h4>操作方式</h4>
  <p>
    移动：<span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> 或方向键（自动射击）<br/>
    炸弹：<span class="kbd">空格</span> / <span class="kbd">B</span> / 屏幕右下「炸弹」按钮（连接灵猫后捏压也可触发）<br/>
    暂停：<span class="kbd">P</span> / 屏幕右上「暂停」按钮　开始 / 重开：<span class="kbd">Enter</span> / 屏幕金色按钮　退出游戏：<span class="kbd">Esc</span>
  </p>

  <h4>玩法规则</h4>
  <p>消灭敌机得分；敌机越过底线会被记为<b>漏怪</b>（不扣血，但郊狼给一次惩罚反馈）。每 5 波出现一次<b>Boss</b>：环形弹幕、追踪扇形、螺旋弹、交叉弹、弹雨五种攻击轮换，低血量进入狂暴。击杀 Boss 得大量分数并奖励炸弹。每第 3 次 Boss 波（15/30/45…）会<b>一次出场两只</b>。</p>

  <h4>核心果实与强化</h4>
  <p>Boss 被击杀后会在原地留下一颗发光的<b>核心果实</b>。把飞机开进拾取范围开始<b>吟唱</b>：需要原地站满约 2.5 秒，期间每 0.7 秒受到一次持续电击、且<b>移速减半</b>（升级是有代价的）；中途离开范围进度会衰减。进度满果实消失，按顺序获得一级强化：</p>
  <ol>
    <li><b>三线射击</b>：单发变三向散射</li>
    <li><b>急速射击</b>：射速 +30%</li>
    <li><b>五线射击</b>：三向变五向散射</li>
    <li><b>重弹核心</b>：子弹伤害 ×2</li>
    <li><b>能量护盾</b>：抵挡一次受击（机身边缘蓝环提示）</li>
    <li><b>过载引擎</b>：移速 +20%，并立即修复 30 HP</li>
  </ol>
  <p>拿满 6 级后循环重来，每一代额外 +25% 伤害、射速小幅提升 —— 吃得越多越强。果实上方会标注吃到的下一级名字，HUD 左上角显示当前强化等级。</p>

  <h4>强度设置</h4>
  <p>在「游戏设置」中调节全局倍率、系统强度上限、受击强度与时长、各设备波形。建议先低倍率逐项手动测试。所有输出都会被钳制在系统强度上限（可调，红线 100）与 APP 安全上限之内。</p>
`;

export const VERSUS_HTML = `
  <p>在线双人对战消消乐：消除自动触发效果电击对方，先达到目标分者胜，败者接受惩罚。双方各自控制自己的郊狼，设备不交给远端。</p>

  <h4>玩法规则</h4>
  <p>点击相邻宝石交换，3 个以上同色消除。消除即自动触发，<b>消几颗决定强度</b>，连锁翻倍：</p>
  <ol>
    <li><b style="color:#ff4c5e">红 · 电击</b>：对对方造成等同消除数的伤害，对方承受值上升、其郊狼被电击</li>
    <li><b style="color:#4cc2ff">蓝 · 护盾</b>：叠加护盾点，1:1 吸收即将到来的伤害</li>
    <li><b style="color:#4cff9d">绿 · 净化</b>：降低自己的承受值</li>
    <li><b style="color:#f0c866">黄 · 时停</b>：冻结对方棋盘数秒</li>
    <li><b style="color:#b06cff">紫 · 倍率</b>：累积得分倍率（最高 ×3），停手衰减</li>
    <li><b style="color:#ff9d4c">橙 · 增幅</b>：使对方受到的伤害加深 10 秒</li>
  </ol>
  <p>4 连生成条纹炸弹（清整行/列），5 连生成彩虹球（清同色）。承受值到 100 会<b>过载</b>：自身棋盘短暂冻结。每局结束刷新历史最高分会进入排行榜。</p>

  <h4>对战流程</h4>
  <p>大厅创建房间得 4 位房间码 → 对方输入加入 → 双方都点「准备」→ 3 秒倒计时开局。对方断开会提示并自动退出；可随时「再来一局」。</p>

  <h4>战败惩罚</h4>
  <p>承受值先到 100 或对方先到目标分即战败：进入惩罚阶段，随机波形持续输出、强度<b>只在你自己设置的范围内</b>（系统强度上限 + 安全红线 100 + APP 安全上限多重钳制），满 10 秒才可认输，胜者也可随时停止惩罚。</p>

  <h4>颜色比例</h4>
  <p>「游戏设置 → 颜色比例」可调整 6 色宝石的刷出权重（双方各自的棋盘用各自的设置）。默认电击多、防御少。</p>
`;

export const ROULETTE_HTML = `
  <p>2 人回合制心理博弈：一把 6 弹巢左轮，每轮随机装入 1~3 发实弹（<b>数量公开、顺序保密</b>）。双方 HP 各 5 点，中弹时自己的郊狼被电击。</p>

  <h4>玩法规则</h4>
  <ol>
    <li>轮流行动，每回合二选一：
      <b>对对方开枪</b> —— 实弹则对方 HP-1，空弹无事；无论结果，回合交给对方</li>
    <li><b>对自己开枪</b> —— 实弹则自己 HP-1 且回合交给对方；<b>空弹则保留回合</b>（俄罗斯轮盘经典博弈）</li>
    <li>弹巢打空后自动进入下一轮：重新装弹，实弹数随轮数递增（最多 3 发）</li>
    <li>HP 先归零者战败，进入与消消乐相同的惩罚流程：胜者实时控制波形与强度，可弹幕互动</li>
  </ol>
  <p>技巧：弹巢剩最后几发且实弹未出时，「对对方开枪」的命中率越来越高；对自己开枪空弹赚回合是翻盘关键。</p>

  <h4>惩罚阶段</h4>
  <p>与电击消消乐完全一致的惩罚面板：胜者点波形名即切换输出、拖动强度滑杆（上限 = 败者自己设置的惩罚强度上限）、随时停止；败者满 10 秒可认输；双方可发弹幕快捷语互相「交流」。</p>
`;

const COMMON_HTML = `
  <h4>昵称档案</h4>
  <p>点击顶栏「昵称」设置全局档案名：小电机弹幕、电击消消乐与排行榜统一使用，首次进入会自动生成临时名（玩家+随机数字），可随时修改。</p>

  <h4>连接步骤</h4>
  <p>点击顶栏「设备」打开二维码；使用 DG-LAB 4 APP 扫码并添加设备后即完成连接。页面打开即自动连接，二维码随时就绪。</p>

  <h4>安全须知</h4>
  <p>顶栏红色 <span class="kbd">■</span> 为紧急停止，任何时候点击都会立即清空所有设备任务并将双通道归零。页面关闭或切后台时也会自动清理。</p>
  <p><b>注意：</b>电脉冲设备存在固有风险，请遵守 DG-LAB 官方安全指引，身体不适请立即停止。</p>

  <h4>异常处理</h4>
  <p>WebSocket 断开会自动重连并刷新二维码；游戏异常刷新页面即可恢复。</p>
`;

export function buildHelpContent(container: HTMLElement): void {
  container.innerHTML = `
    <div class="tabs">
      ${TABS.map((t) => `<button class="tab help-tab" data-help="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div class="help-body-text" id="help-body-pane"></div>
  `;

  const pane = container.querySelector<HTMLElement>('#help-body-pane')!;
  const switchTab = (key: TabKey): void => {
    container.querySelectorAll<HTMLElement>('.help-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.help === key);
    });
    pane.innerHTML = (key === 'bullet' ? BULLET_HTML : key === 'versus' ? VERSUS_HTML : ROULETTE_HTML) + COMMON_HTML;
  };

  container.querySelectorAll<HTMLElement>('.help-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.help as TabKey));
  });

  switchTab('bullet');
}
