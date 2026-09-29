import type { Node } from 'web-tree-sitter'

// Labels are UI only. Serialized values are C++ spellings (never labels or
// separator sentinels). Simple pointer stars belong to the type; references,
// arrays and function pointers keep their declarator structure.
export const cppTypeOptions: [string, string][] = [
  ['整型 (int)', 'int'], ['布尔型 (bool)', 'bool'], ['字符型 (char)', 'char'],
  ['字符指针 (char*)', 'char*'], ['字节指针 (uint8_t*)', 'uint8_t*'],
  ['通用指针 (void*)', 'void*'],
  ['8位整型 (int8_t)', 'int8_t'], ['16位整型 (int16_t)', 'int16_t'],
  ['32位整型 (int32_t)', 'int32_t'], ['64位整型 (int64_t)', 'int64_t'],
  ['8位无符号整型 (uint8_t)', 'uint8_t'], ['16位无符号整型 (uint16_t)', 'uint16_t'],
  ['32位无符号整型 (uint32_t)', 'uint32_t'], ['64位无符号整型 (uint64_t)', 'uint64_t'],
  ['短整型 (short)', 'short'], ['长整型 (long)', 'long'], ['长长整型 (long long)', 'long long'],
  ['无符号整型 (unsigned int)', 'unsigned int'], ['无符号短整型 (unsigned short)', 'unsigned short'],
  ['无符号长整型 (unsigned long)', 'unsigned long'], ['无符号长长整型 (unsigned long long)', 'unsigned long long'],
  ['有符号字符型 (signed char)', 'signed char'], ['无符号字符型 (unsigned char)', 'unsigned char'],
  ['浮点型 (float)', 'float'], ['双精度浮点型 (double)', 'double'], ['长双精度浮点型 (long double)', 'long double'],
  ['字节型 (byte)', 'byte'], ['字符串型 (String)', 'String'], ['大小类型 (size_t)', 'size_t'],
  ['自动推导 (auto)', 'auto'], ['空类型 (void)', 'void']
]

export function simplePointerNameStart(declarator: Node): number | undefined {
  let current = declarator.type === 'init_declarator' ? declarator.childForFieldName('declarator') : declarator
  if (current?.type !== 'pointer_declarator') return undefined
  while (current?.type === 'pointer_declarator') current = current.childForFieldName('declarator')
  return current?.type === 'identifier' ? current.startIndex : undefined
}

export function declarationText(fields: Record<string, string> | undefined, name: string): string {
  return [fields?.QUALIFIERS, fields?.TYPE, fields?.[name]].filter(Boolean).join(' ')
}
