/** 游戏说明弹窗内容 */
export function buildHelpContent(container: HTMLElement): void {
  container.innerHTML = `
    <div class="help-body-text">
      <p>本游戏为 DG-LAB Socket V4 协议的弹幕游戏，支持 <b>郊狼 / 负鼠 / 灵猫</b> 三设备联动：</p>
      <ol>
        <li><b>郊狼</b>：受击时输出电击脉冲，低血量时另一通道持续警告，死亡时一波爆发</li>
        <li><b>负鼠</b>：受击时振动反馈，炸弹触发奖励振动</li>
        <li><b>灵猫</b>：作为输入设备 —— 游戏中捏压触发炸弹，清空全屏敌弹</li>
      </ol>

      <h4>1. 连接步骤</h4>
      <p>点击顶栏「连接」或「设备」，打开二维码；使用 DG-LAB 4 APP 扫码并添加设备后即完成连接。也可在「服务器地址连接」标签页填写自部署中继地址。</p>

      <h4>2. 操作方式</h4>
      <p>
        移动：<span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> 或方向键（自动射击）<br/>
        炸弹：<span class="kbd">空格</span> / <span class="kbd">B</span> / 屏幕右下「炸弹」按钮（连接灵猫后捏压也可触发）<br/>
        暂停：<span class="kbd">P</span> / 屏幕右上「暂停」按钮　开始 / 重开：<span class="kbd">Enter</span> / 屏幕中央金色按钮　退出游戏：<span class="kbd">Esc</span>
      </p>

      <h4>3. 强度设置</h4>
      <p>在「游戏设置」中调节全局倍率、受击强度与时长、各设备波形。建议先低倍率逐项手动测试。所有输出都会被钳制在 APP 内设置的通道上限之内。</p>

      <h4>4. 安全须知</h4>
      <p>顶栏红色 <span class="kbd">■</span> 为紧急停止，任何时候点击都会立即清空所有设备任务并将双通道归零。页面关闭或切后台时也会自动清理。</p>
      <p>⚠️ 电脉冲设备存在固有风险，请遵守 DG-LAB 官方安全指引，身体不适请立即停止。</p>

      <h4>5. 异常处理</h4>
      <p>WebSocket 断开会自动清空设备缓存，重新扫码即可恢复；游戏异常刷新页面即可。</p>
    </div>
  `;
}
