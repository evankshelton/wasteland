// Toxic water in the first-person arena: one flat surface at the water level,
// shown only where the terrain is water (blended exactly like the ground, so
// the shoreline meanders with it), fading out at the edges.
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_disabled;

#include "res://shaders/arena_cells.gdshaderinc"

uniform float water_id = 11.0;
uniform vec3 colour : source_color = vec3(0.08, 0.3, 0.26);

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec4 ids;
	vec2 f;
	arena_cells(world_pos.xz, ids, f);
	float water = arena_weight(ids, f, water_id);
	if (water < 0.35) {
		discard;
	}
	float ripple = texture(breakup, world_pos.xz / 18.0 + TIME * vec2(0.01, 0.006)).b;
	ALBEDO = colour * (0.85 + 0.3 * ripple);
	EMISSION = vec3(0.02, 0.14, 0.06) * (0.6 + 0.4 * ripple);
	ROUGHNESS = 0.15;
	METALLIC = 0.2;
	ALPHA = smoothstep(0.35, 0.6, water) * 0.85;
}
