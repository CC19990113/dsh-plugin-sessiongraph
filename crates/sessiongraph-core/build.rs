// napi needs the linker flags this generates (on macOS: `-undefined dynamic_lookup`), without
// which a cdylib referencing Node's `napi_*` symbols would fail to link.
fn main() {
    napi_build::setup();
}
