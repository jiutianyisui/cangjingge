// ---------------------------------------------------------------------------
// dsh-cangjingge —— 宿主半的「零依赖配置层」
//
// 【为什么需要这个文件】
//   cordis 解析插件配置时调用的是
//     `Config['~standard'].validate(config)`
//   （Standard Schema 接口）。给一个**普通 JSON Schema 对象**会在启动时崩：
//     Cannot read properties of undefined (reading 'validate')
//   —— 天枢在真实环境踩过，这里沿用它内联的做法。
//
//   官方做法是 `import Schema from '@deepseek-ai/schemastery'`，但本插件刻意
//   不声明任何 @deepseek-ai/* 依赖：一旦装进 profile 就会顶掉桌面端自带的
//   那一份，版本错配 -> 服务起不来 -> 整个软件打不开。所以这里内联一个
//   最小等价实现。
// ---------------------------------------------------------------------------

/**
 * 判定一个值是不是「普通 JSON 对象」。
 * @param value - 待判定值。
 * @returns 是否普通对象。
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 一个最小的 Standard Schema 实现：按字段类型兜底 + 补默认值。
 *
 * 与 Schemastery 的差异只在**校验严格度**上：脏值不报错、回落默认值。
 * 对插件配置足够，而且更不容易因为一个笔误把插件拦在门外。
 *
 * @param fields - 字段名 -> { type, default, description }。
 * @returns 带 `~standard` 接口的配置 schema。
 */
export function defineConfig(fields) {
  const spec = isPlainObject(fields) ? fields : {}
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-cangjingge',
      /**
       * 校验并归一化配置。
       * @param value - 用户给的原始配置。
       * @returns { value } 归一化后的配置。
       */
      validate(value) {
        const input = isPlainObject(value) ? value : {}
        const output = {}
        for (const key of Object.keys(spec)) {
          const field = spec[key]
          const fallback = field !== null && typeof field === 'object' ? field.default : undefined
          const given = input[key]
          if (given === undefined) {
            if (fallback !== undefined) output[key] = fallback
            continue
          }
          const wanted = field !== null && typeof field === 'object' ? field.type : undefined
          if (wanted === 'boolean' && typeof given !== 'boolean') {
            output[key] = fallback === undefined ? Boolean(given) : fallback
            continue
          }
          if (wanted === 'string' && typeof given !== 'string') {
            if (fallback !== undefined) { output[key] = fallback; continue }
            output[key] = String(given)
            continue
          }
          output[key] = given
        }
        // 未声明的键原样保留：用户可能用了更新版本的键，丢掉只会让
        // 「配置消失」这种怪现象更难查。
        for (const key of Object.keys(input)) {
          if (!Object.prototype.hasOwnProperty.call(output, key)) output[key] = input[key]
        }
        return { value: output }
      },
    },
  }
}
