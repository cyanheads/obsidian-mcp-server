import { z } from "zod";

/**
 * Converts a Zod typeName to the corresponding JSON Schema type string.
 * @param typeName - The Zod typeName (e.g., "ZodString", "ZodNumber", "ZodBoolean")
 * @returns The JSON Schema type string (e.g., "string", "number", "boolean")
 */
function zodTypeNameToJsonType(typeName: string): string {
  const typeMap: Record<string, string> = {
    ZodString: "string",
    ZodNumber: "number",
    ZodBoolean: "boolean",
    ZodArray: "array",
    ZodObject: "object",
    ZodEnum: "string",
    ZodOptional: "string", // Will be handled specially
    ZodDefault: "string", // Will be handled specially
    ZodLiteral: "string",
    ZodUnion: "string", // Simplified - unions become string for enum-like usage
    ZodIntersection: "object",
    ZodRecord: "object",
    ZodMap: "object",
    ZodSet: "array",
    ZodFunction: "object",
    ZodLazy: "object",
    ZodNativeEnum: "string",
    ZodEffects: "string", // Transform effects inherit from inner type
    ZodTuple: "array",
    ZodUndefined: "undefined",
    ZodNull: "null",
    ZodAny: "object",
    ZodUnknown: "object",
    ZodNever: "null",
    ZodVoid: "null",
  };

  const result = typeMap[typeName] || "object";
  return result;
}

/**
 * Extracts the JSON Schema type from a Zod field definition, handling wrapped types
 * like ZodOptional, ZodDefault, etc.
 */
function extractJsonType(def: any): { type: string; innerDef?: any } {
  const typeName = def.typeName;

  // Handle wrapped types
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    const innerType = def.innerType?._def || def._def?.innerType;
    if (innerType) {
      const inner = extractJsonType(innerType);
      return { type: inner.type, innerDef: inner };
    }
  }

  // Handle ZodEffects (e.g., ZodString with transformations)
  if (typeName === "ZodEffects") {
    const innerType = def.innerType?._def;
    if (innerType) {
      return extractJsonType(innerType);
    }
  }

  // Handle arrays
  if (typeName === "ZodArray") {
    return { type: "array", innerDef: def };
  }

  // Handle enum - extract values
  if (typeName === "ZodEnum") {
    return { type: "string", innerDef: def };
  }

  // Handle literal
  if (typeName === "ZodLiteral") {
    return { type: typeof def.value };
  }

  // Handle base types
  return { type: zodTypeNameToJsonType(typeName), innerDef: def };
}

/**
 * Extracts description from a Zod field definition.
 */
function extractDescription(def: any): string | undefined {
  // Check description in various places Zod stores it
  if (def.description) {
    return def.description;
  }
  // For wrapped types, check inner
  if (def.innerType?._def?.description) {
    return def.innerType._def.description;
  }
  if (def._def?.innerType?._def?.description) {
    return def._def.innerType._def.description;
  }
  return undefined;
}

/**
 * Extracts default value from a Zod field definition.
 */
function extractDefault(def: any): any {
  if (def.typeName === "ZodDefault") {
    return def.defaultValue();
  }
  if (def.innerType?._def?.typeName === "ZodDefault") {
    return def.innerType._def.defaultValue();
  }
  return undefined;
}

/**
 * Extracts enum values from a Zod schema definition.
 */
function extractEnumValues(def: any): string[] | undefined {
  if (def.typeName === "ZodEnum") {
    return def.values;
  }
  if (def.innerType?._def?.typeName === "ZodEnum") {
    return def.innerType._def.values;
  }
  if (def._def?.innerType?._def?.typeName === "ZodEnum") {
    return def._def.innerType._def.values;
  }
  return undefined;
}

/**
 * Converts a Zod schema shape object to a proper JSON Schema object with explicit type fields.
 *
 * @param shape - The Zod schema shape object (from `schema.shape`)
 * @returns A JSON Schema object with explicit `type` fields for each property
 */
export function convertZodShapeToJsonSchema(
  shape: Record<string, any>,
): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, fieldDef] of Object.entries(shape)) {
    const def = fieldDef._def || fieldDef;
    const { type, innerDef } = extractJsonType(def);
    const description = extractDescription(def);
    const enumValues = extractEnumValues(def);
    const defaultValue = extractDefault(def);

    const propertySchema: Record<string, any> = {
      type,
    };

    if (description) {
      propertySchema.description = description;
    }

    if (enumValues) {
      propertySchema.enum = enumValues;
      // Remove type when enum is present as it's more specific
      delete propertySchema.type;
    }

    if (defaultValue !== undefined) {
      propertySchema.default = defaultValue;
    }

    // Handle array items
    if (type === "array" && def.typeName === "ZodArray") {
      const itemsDef = def.innerType?._def || def._def?.innerType;
      if (itemsDef) {
        const itemsType = extractJsonType(itemsDef);
        propertySchema.items = { type: itemsType.type };
        if (itemsType.innerDef?.typeName === "ZodEnum") {
          propertySchema.items.enum = itemsType.innerDef.values;
          delete propertySchema.items.type;
        }
      }
    }

    properties[key] = propertySchema;

    // Field is required if it doesn't have ZodOptional wrapper
    const isOptional =
      def.typeName === "ZodOptional" ||
      fieldDef.isOptional?.() ||
      false;
    if (!isOptional) {
      required.push(key);
    }
  }

  const result: Record<string, any> = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}

/**
 * Creates a JSON Schema from a Zod schema that can be used with MCP SDK.
 * This ensures all fields have explicit "type" declarations.
 *
 * @param schema - A Zod schema (or schema shape)
 * @returns A JSON Schema object with explicit type fields
 */
export function createJsonSchema(
  schema: z.ZodTypeAny | Record<string, any>,
): Record<string, any> {
  // If it's already a Zod schema, get its shape
  const shape =
    'shape' in schema
      ? (schema as z.ZodObject<any>).shape
      : 'shape' in (schema as any)?._def
        ? (schema as any)._def.shape
        : (schema as Record<string, any>);

  return convertZodShapeToJsonSchema(shape);
}
