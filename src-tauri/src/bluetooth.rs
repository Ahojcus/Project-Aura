//! Bluetooth device battery info — a free-tier "Smart Notch" feature.
//!
//! Uses the Windows Device Enumeration API with a Bluetooth AEP selector to
//! find connected devices and read their battery percent property where the
//! device exposes it. Polls every 15s (battery levels change slowly).
//! Non-Windows platforms compile but return an empty list.

use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize)]
pub struct BtDevice {
    pub name: String,
    pub battery_percent: Option<u8>,
}

pub type BtList = Arc<Mutex<Vec<BtDevice>>>;

const POLL_MS: u64 = 15_000;

pub fn spawn_bluetooth_thread() -> BtList {
    let list: BtList = Arc::new(Mutex::new(Vec::new()));
    #[cfg(windows)]
    {
        let inner = list.clone();
        std::thread::spawn(move || loop {
            let devices = poll_devices();
            if let Ok(mut slot) = inner.lock() {
                if !devices.is_empty() || slot.is_empty() {
                    *slot = devices;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        });
    }
    list
}

#[cfg(windows)]
fn poll_devices() -> Vec<BtDevice> {
    let mut out = Vec::new();
    use windows::core::{HSTRING, Interface as _};
    use windows::Devices::Enumeration::DeviceInformation;

    // Connected audio ("LE audio" AEP) OR classic Bluetooth devices.
    const BLE_AUDIO: &str = "System.Devices.Aep.ProtocolId:=\"{bb7bb05e-5a5f-44a9-97af-7a2f2a6c3e9c}\"";
    const CLASSIC: &str = "System.Devices.Aep.ProtocolId:=\"{e0cbf06c-cd8b-4647-bb8b-7b4b9d5b1e46}\"";
    const CONNECTED: &str = "System.Devices.Aep.IsConnected:=System.StructuredQueryType.Boolean#True";
    let selector = HSTRING::from(format!("({}) OR ({}) AND {}", BLE_AUDIO, CLASSIC, CONNECTED));

    // Build the requested-property list at runtime (IInspectable) and query
    // its IIterable interface — avoids array-Param trait mismatch between
    // windows-core versions in the dependency graph.
    let props = [
        HSTRING::from("System.ItemNameDisplay"),
        HSTRING::from("System.DeviceInterface.Bluetooth.BatteryPercent"),
    ];
    let prop_obj = match windows::Foundation::PropertyValue::CreateStringArray(&props) {
        Ok(o) => o,
        Err(_) => return out,
    };
    let iterable = match
        prop_obj.cast::<windows::Foundation::Collections::IIterable<HSTRING>>() {
        Ok(i) => i,
        Err(_) => return out,
    };
    let operation = DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
        &selector,
        &iterable,
    );
    let collection = match operation {
        Ok(op) => match op.get() { Ok(c) => c, Err(_) => return out },
        Err(_) => return out,
    };

    let Ok(size) = collection.Size() else { return out };
    for i in 0..size {
        let Ok(info) = collection.GetAt(i) else { continue };
        let name = info.Name().map(|n| n.to_string()).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let Ok(props_map) = info.Properties() else { continue };
        let battery = props_map
            .Lookup(&HSTRING::from("System.DeviceInterface.Bluetooth.BatteryPercent"))
            .ok()
            .and_then(prop_to_percent);
        out.push(BtDevice { name, battery_percent: battery });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Decode a device-property value into a 0-100 battery percent. The property
/// store can box the number as several numeric types, so branch on its kind.
fn prop_to_percent(v: windows::core::IInspectable) -> Option<u8> {
    use windows::core::Interface as _;
    use windows::Foundation::{IPropertyValue, PropertyType};
    let val = v.cast::<IPropertyValue>().ok()?;
    let n = match val.Type().ok()? {
        PropertyType::UInt8 => val.GetUInt8().ok().map(|n| n as f64),
        PropertyType::UInt16 => val.GetUInt16().ok().map(|n| n as f64),
        PropertyType::UInt32 => val.GetUInt32().ok().map(|n| n as f64),
        PropertyType::Int32 => val.GetInt32().ok().map(|n| n as f64),
        PropertyType::Int16 => val.GetInt16().ok().map(|n| n as f64),
        PropertyType::Single => val.GetSingle().ok().map(|n| n as f64),
        PropertyType::Double => val.GetDouble().ok(),
        _ => None,
    }?;
    if !(0.0..=100.0).contains(&n) {
        return None;
    }
    Some(n.round() as u8)
}
