use std::time::{Duration, Instant};
use serde::Serialize;
use sysinfo::{Networks, System};

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub cpu_percent: f32,
    pub mem_used_gb: f64,
    pub mem_total_gb: f64,
    pub net_down_bps: f64,
    pub net_up_bps: f64,
}

pub fn spawn_sys_thread() -> crate::commands::SysState {
    let state = crate::commands::SysState::default();
    let state2 = crate::commands::SysState {
        snapshot: state.snapshot.clone(),
    };
    std::thread::Builder::new()
        .name("mon-sys".into())
        .spawn(move || run_loop(state2))
        .expect("spawn sysmon thread");
    state
}

fn run_loop(state: crate::commands::SysState) {
    let mut sys = System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    let mut nets = Networks::new_with_refreshed_list();
    nets.refresh(false);
    let mut prev: Option<(Instant, u64, u64)> = None;

    loop {
        sys.refresh_memory();
        sys.refresh_cpu_usage();
        nets.refresh(false);

        let mut rx_total: u64 = 0;
        let mut tx_total: u64 = 0;
        for (_name, data) in nets.iter() {
            rx_total = rx_total.saturating_add(data.total_received());
            tx_total = tx_total.saturating_add(data.total_transmitted());
        }
        let now = Instant::now();
        let (down, up) = if let Some((t, rx0, tx0)) = prev {
            let secs = now.duration_since(t).as_secs_f64().max(1e-3);
            (
                (rx_total.saturating_sub(rx0)) as f64 / secs,
                (tx_total.saturating_sub(tx0)) as f64 / secs,
            )
        } else {
            (0.0, 0.0)
        };
        prev = Some((now, rx_total, tx_total));

        let cpu_percent = sys.global_cpu_usage();
        let mem_used = sys.used_memory() as f64 / 1_073_741_824.0;
        let mem_total = sys.total_memory() as f64 / 1_073_741_824.0;
        *state.snapshot.lock().unwrap() = Some(SystemSnapshot {
            cpu_percent,
            mem_used_gb: mem_used,
            mem_total_gb: mem_total,
            net_down_bps: down,
            net_up_bps: up,
        });

        std::thread::sleep(Duration::from_millis(1500));
    }
}
