// Presentation for C++/Arduino core syntax, inspired by the Blockly core library.
// Project libraries continue to use generic header discovery and API extraction.
export type CodeOption = [label: string, code: string]
export interface CoreCall {
  name: string; label: string; parameters: string[]; suffix?: string; help: string; family?: string
}
export const coreCalls: CoreCall[] = [
  { name: 'pinMode', label: '设置引脚模式', parameters: ['引脚', '模式'], help: '输入用于读取信号，输出用于控制灯或其他设备。' },
  { name: 'digitalWrite', label: '设置数字引脚', parameters: ['引脚', '电平'], help: '向引脚输出高电平或低电平；请先设置为输出模式。' },
  { name: 'digitalRead', label: '读取数字引脚', parameters: ['引脚'], help: '读取引脚当前的高电平或低电平。' },
  { name: 'analogRead', label: '读取模拟引脚', parameters: ['引脚'], help: '读取传感器的模拟数值，范围取决于开发板。' },
  { name: 'analogWrite', label: '输出 PWM 信号', parameters: ['引脚', '数值'], help: '输出 PWM 信号；支持的引脚和数值范围取决于开发板。' },
  { name: 'delay', label: '等待（毫秒）', parameters: ['时长'], suffix: '毫秒', family: 'delay', help: '暂停一会儿再继续；1000 毫秒等于 1 秒。' },
  { name: 'delayMicroseconds', label: '等待（微秒）', parameters: ['时长'], suffix: '微秒', family: 'delay', help: '短暂等待；1000 微秒等于 1 毫秒。' },
  { name: 'millis', label: '获取运行时间（毫秒）', parameters: [], family: 'clock', help: '设备启动到现在经过的毫秒数。' },
  { name: 'micros', label: '获取运行时间（微秒）', parameters: [], family: 'clock', help: '设备启动到现在经过的微秒数。' },
  { name: 'Serial.begin', label: '启动串口', parameters: ['波特率'], help: '设置串口通信速度，例如 115200；应放在初始化中。' },
  { name: 'Serial.print', label: '串口输出', parameters: ['内容'], family: 'print', help: '输出文字或数值，后面的内容接在同一行。' },
  { name: 'Serial.println', label: '串口输出并换行', parameters: ['内容'], family: 'print', help: '输出文字或数值，然后另起一行。' },
  { name: 'Serial.available', label: '串口可读取的字节数', parameters: [], help: '大于 0 表示有数据可以读取。' },
  { name: 'Serial.read', label: '读取串口的一个字节', parameters: [], help: '读取一个字节；没有数据时返回 -1。' },
  { name: 'Serial.write', label: '串口发送字节', parameters: ['字节'], help: '直接发送一个字节数值。' },
  { name: 'Serial.flush', label: '等待串口发送完成', parameters: [], help: '等待已经排队的输出数据发送完成。' },
  { name: 'abs', label: '取绝对值', parameters: ['数值'], help: '去掉数值的正负号，例如 -3 变为 3。' },
  { name: 'min', label: '取较小值', parameters: ['数值一', '数值二'], family: 'minmax', help: '比较两个数，返回其中较小的数。' },
  { name: 'max', label: '取较大值', parameters: ['数值一', '数值二'], family: 'minmax', help: '比较两个数，返回其中较大的数。' },
  { name: 'constrain', label: '限制数值范围', parameters: ['数值', '最小值', '最大值'], help: '低于最小值时取最小值，高于最大值时取最大值。' },
  { name: 'map', label: '换算数值范围', parameters: ['数值', '原最小值', '原最大值', '新最小值', '新最大值'], help: '按比例把一个范围内的整数换算到另一个范围。' },
  { name: 'random', label: '产生随机整数', parameters: ['最小值', '上限（不含）'], help: '随机结果包含最小值，但不包含上限。' },
  { name: 'String', label: '转换为文字', parameters: ['数值或内容'], help: '把数值等内容转换为 Arduino String 文字。' },
  { name: 'attachInterrupt', label: '设置引脚中断', parameters: ['中断编号', '处理函数', '触发方式'], help: '信号满足触发条件时调用处理函数；中断编号与开发板有关。' },
  { name: 'detachInterrupt', label: '取消引脚中断', parameters: ['中断编号'], help: '停止指定引脚中断的回调。' },
  { name: 'interrupts', label: '允许中断', parameters: [], family: 'interrupts', help: '重新允许中断响应。' },
  { name: 'noInterrupts', label: '暂停中断', parameters: [], family: 'interrupts', help: '临时暂停中断响应，应尽快恢复。' }
]
export const coreCall = (name: string, count?: number): CoreCall | undefined => coreCalls.find(call => call.name === name && (count === undefined || call.parameters.length === count))
const comparisons: CodeOption[] = [['等于', '=='], ['不等于', '!='], ['小于', '<'], ['小于或等于', '<='], ['大于', '>'], ['大于或等于', '>=']]
const arithmetic: CodeOption[] = [['加', '+'], ['减', '-'], ['乘', '*'], ['除', '/'], ['求余数', '%']]
const assignments: CodeOption[] = [['设为', '='], ['增加', '+='], ['减少', '-='], ['乘以', '*='], ['除以', '/='], ['取余后设为', '%='], ['按位与后设为', '&='], ['按位或后设为', '|='], ['按位异或后设为', '^='], ['左移后设为', '<<='], ['右移后设为', '>>=']]
const logical: CodeOption[] = [['并且', '&&'], ['或者', '||']]
const bitwise: CodeOption[] = [['按位与', '&'], ['按位或', '|'], ['按位异或', '^'], ['左移', '<<'], ['右移', '>>']]
const constants: CodeOption[][] = [
  [['成立（真）', 'true'], ['不成立（假）', 'false']],
  [['高电平', 'HIGH'], ['低电平', 'LOW']],
  [['输入', 'INPUT'], ['输出', 'OUTPUT'], ['上拉输入', 'INPUT_PULLUP']],
  [['电平变化', 'CHANGE'], ['上升沿', 'RISING'], ['下降沿', 'FALLING']]
]
export const isSimpleConstant = (value: string): boolean => constants.some(options => options.some(([, code]) => code === value))
export function literalBlock(text: string): { type: string; fields: { TEXT: string } } {
  try { if (text.startsWith('"')) return { type: 'cpp_preview_text', fields: { TEXT: JSON.parse(text) as string } } } catch { /* Keep C++-specific escapes verbatim. */ }
  return { type: `cpp_preview_${isSimpleConstant(text) ? 'choice' : 'value'}`, fields: { TEXT: text } }
}
export function codeOptions(kind: string, current: string): CodeOption[] {
  let options: CodeOption[]
  if (kind === 'operator') options = [comparisons, arithmetic, assignments, logical, bitwise].find(group => group.some(([, code]) => code === current)) ?? arithmetic
  else if (kind === 'constant') options = constants.find(group => group.some(([, code]) => code === current)) ?? constants[0]!
  else if (kind === 'flow') options = [['跳出循环或分支', 'break;'], ['继续下一轮循环', 'continue;']]
  else if (kind === 'while') options = [['当条件成立时重复', 'while'], ['重复直到条件成立', 'until'], ['先执行一次，再判断条件', 'do']]
  else if (kind === 'qualifiers') options = [
    ['可修改', ''], ['常量', 'const'], ['静态存储', 'static'],
    ['静态常量', 'static const'], ['常量静态存储', 'const static'],
    ['易变值', 'volatile'], ['常量易变值', 'const volatile'],
    ['编译时常量', 'constexpr'], ['静态编译时常量', 'static constexpr'],
    ['外部声明', 'extern'], ['外部常量声明', 'extern const'],
    ['线程局部存储', 'thread_local'], ['内联变量', 'inline']
  ]
  else if (kind === 'action') {
    const call = coreCall(current)
    options = call ? coreCalls.filter(item => item.name === current || call.family && item.family === call.family).map(item => [item.label, item.name]) : [[current || '操作', current]]
  } else options = []
  if (options.some(([, code]) => code === current) || !current && kind !== 'qualifiers') return options
  if (kind === 'qualifiers') {
    const labels: Record<string, string> = { const: '常量', static: '静态存储', volatile: '易变值', constexpr: '编译时常量', extern: '外部声明', thread_local: '线程局部存储', inline: '内联变量', mutable: '可变成员', register: '寄存器提示', constinit: '静态初始化', consteval: '编译期求值' }
    const tokens = current.trim().split(/\s+/)
    const translated = tokens.every(token => labels[token]) ? tokens.map(token => labels[token]).join(' · ') : '源码修饰符'
    return [[`${translated} (${current})`, current], ...options]
  }
  return [[current || '沿用原文', current], ...options]
}

export function signatureLabel(value: string): string {
  if (/^void\s+setup\s*\(\s*(?:void)?\s*\)$/.test(value)) return '开机时执行一次'
  if (/^void\s+loop\s*\(\s*(?:void)?\s*\)$/.test(value)) return '持续重复执行'
  return value
}

export const blockHelp: Record<string, string> = {
  function: '把要执行的积木放进内部；程序会从上到下执行。setup 执行一次，loop 持续重复。',
  declaration: '创建变量：给它起一个名字，选择类型，再设置初始值。', definition: '创建变量或对象；类型决定它能保存什么数据。',
  if: '条件成立时执行里面的积木；用加号添加“否则”或其他条件。',
  repeat: '从 0 开始计数，每次加 1；计数小于次数时继续执行。',
  text: '直接输入文字，生成代码时会自动处理引号、换行和反斜杠。',
  while: '根据条件重复执行；请选择先判断、直到成立或先执行一次。',
  binary: '用下拉框选择比较、计算或赋值方式。', choice: '从下拉框中选择固定值，不需要记住 C++ 拼写。',
  call: '调用一个函数。把参数积木放进对应插槽；加号可以增减参数。',
  statement: '执行内部的操作，然后继续下一块。', return: '结束当前函数；需要返回结果时连接一个值。',
  loop: '较复杂的循环保留完整 C++ 规则，可在属性中编辑。',
  raw: '这段 C++ 保留原文，可以在下方属性中编辑。', raw_value: '保留原始表达式，可在属性中编辑。',
  flow: '跳出当前循环或 switch；“继续”会跳过本轮余下步骤。'
}

/** Search supports the words shown to beginners as well as the actual C++ name. */
export function beginnerSearchText(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const block = item as { type?: string; fields?: Record<string, string>; inputs?: Record<string, { block?: unknown }> }
  const type = block.type?.replace('cpp_preview_', '') ?? ''
  const call = coreCall(block.fields?.NAME ?? '')
  return [blockHelp[type] ?? '', call ? [call.label, call.help, ...call.parameters].join(' ') : '',
    block.fields?.SIGNATURE ? signatureLabel(block.fields.SIGNATURE) : '',
    ...Object.values(block.inputs ?? {}).map(input => beginnerSearchText(input.block))].join(' ')
}
